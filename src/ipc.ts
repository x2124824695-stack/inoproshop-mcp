/**
 * File-based IPC transport layer.
 * Writes command files, polls for result files, with command serialization.
 */

import * as fs from 'fs';
import * as path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { IpcConfig, IpcResult, IpcCommand, RequestId } from './types';
import { ipcLog } from './logger';
import { WATCHER_VERSION } from './protocol';

/** Default IPC configuration */
export const DEFAULT_IPC_CONFIG: Omit<IpcConfig, 'baseDir' | 'sessionToken'> = {
  commandTimeoutMs: 60_000,
  pollIntervalMs: 100,
  maxPollIntervalMs: 1_000,
  deleteResultAfterRead: true,
};

/**
 * Async mutex for serializing commands.
 * Ensures only one command is in-flight at a time.
 */
class AsyncMutex {
  private _queue: Array<() => void> = [];
  private _locked = false;

  async acquire(): Promise<void> {
    if (!this._locked) {
      this._locked = true;
      return;
    }
    return new Promise<void>((resolve) => {
      this._queue.push(resolve);
    });
  }

  release(): void {
    if (this._queue.length > 0) {
      const next = this._queue.shift()!;
      next();
    } else {
      this._locked = false;
    }
  }
}

/**
 * Atomic file write: write to .tmp then rename.
 * Uses fsync to ensure data is flushed to disk before rename.
 */
async function atomicWrite(filePath: string, content: string): Promise<void> {
  const tmpPath = filePath + '.tmp';
  const fd = fs.openSync(tmpPath, 'w');
  try {
    fs.writeSync(fd, content, undefined, 'utf-8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmpPath, filePath);
}

export class IpcClient {
  private config: IpcConfig;
  private mutex = new AsyncMutex();
  private commandsDir: string;
  private resultsDir: string;

  constructor(config: IpcConfig) {
    this.config = config;
    this.commandsDir = path.join(config.baseDir, 'commands');
    this.resultsDir = path.join(config.baseDir, 'results');
  }

  /** Create commands/ and results/ directories */
  async ensureDirectories(): Promise<void> {
    fs.mkdirSync(this.commandsDir, { recursive: true });
    fs.mkdirSync(this.resultsDir, { recursive: true });
    ipcLog.debug(`IPC directories created at ${this.config.baseDir}`);
  }

  /** Check if the watcher has written ready.signal */
  async isReady(): Promise<boolean> {
    const signalPath = path.join(this.config.baseDir, 'ready.signal');
    try {
      const info = JSON.parse(fs.readFileSync(signalPath, 'utf8'));
      return info.sessionToken === this.config.sessionToken && info.version === WATCHER_VERSION;
    } catch { return false; }
  }

  /** Write terminate.signal to request watcher shutdown */
  async sendTerminate(): Promise<void> {
    const signalPath = path.join(this.config.baseDir, 'terminate.signal');
    await atomicWrite(signalPath, JSON.stringify({ timestamp: Date.now(), sessionToken: this.config.sessionToken }));
    ipcLog.info('Terminate signal sent');
  }

  /**
   * Send a command to the watcher and wait for result.
   * Serialized via async mutex — only one command in-flight at a time.
   */
  async sendCommand(scriptContent: string, timeoutMs?: number): Promise<IpcResult> {
    await this.mutex.acquire();
    try {
      return await this._sendCommandInternal(scriptContent, timeoutMs);
    } finally {
      this.mutex.release();
    }
  }

  private async _sendCommandInternal(
    scriptContent: string,
    timeoutMs?: number
  ): Promise<IpcResult> {
    await this.discoverPending();
    if (fs.existsSync(path.join(this.config.baseDir, 'uncertain.json'))) {
      throw new Error('A previous command timed out; execution may still be running. Use get_command_status then recover_session. Do not retry the mutation.');
    }
    const requestId: RequestId = uuidv4();
    const timeout = timeoutMs ?? this.config.commandTimeoutMs;
    if (!Number.isFinite(timeout) || timeout <= 0) throw new Error('Invalid command timeout.');
    const scriptFileName = `${requestId}.py`;
    const commandFileName = `${requestId}.command.json`;
    const resultFileName = `${requestId}.result.json`;

    const scriptPath = path.join(this.commandsDir, scriptFileName);
    const commandPath = path.join(this.commandsDir, commandFileName);
    const resultPath = path.join(this.resultsDir, resultFileName);

    ipcLog.debug(`Sending command ${requestId}`);

    // Step 1: Write .py script file with fsync
    await atomicWrite(scriptPath, scriptContent);

    // Step 2: Write .command.json (triggers watcher)
    const command: IpcCommand = {
      requestId,
      scriptPath: scriptPath,
      timestamp: Date.now(),
      sessionToken: this.config.sessionToken,
      deadline: Date.now() + timeout,
    };
    await atomicWrite(commandPath, JSON.stringify(command));

    ipcLog.debug(`Command ${requestId} written, polling for result...`);

    // Step 3: Poll for result with progressive backoff
    const startTime = Date.now();
    let pollInterval = this.config.pollIntervalMs;

    while (Date.now() - startTime < timeout) {
      if (fs.existsSync(resultPath)) {
        // Try to read result with retry for partial writes
        const result = await this._readResultWithRetry(resultPath, requestId);
        if (result) {
          // Clean up result file if configured
          if (this._cleanupCommandFiles(requestId) && this.config.deleteResultAfterRead) {
            try {
              fs.unlinkSync(resultPath);
            } catch {
              // Ignore cleanup errors
            }
          }
          ipcLog.debug(
            `Command ${requestId} completed: success=${result.success}`
          );
          return result;
        }
      }

      // Progressive backoff: double interval, cap at max
      await this._sleep(pollInterval);
      pollInterval = Math.min(pollInterval * 2, this.config.maxPollIntervalMs);
    }

    // A timeout is NOT a cancellation. Leave the request intact so the
    // watcher can publish its outcome; a persistent latch survives reconnect.
    await atomicWrite(path.join(this.config.baseDir, 'uncertain.json'), JSON.stringify({requestId, timestamp: Date.now()}));

    throw new Error(
      `Command ${requestId} timed out after ${timeout}ms; outcome is UNKNOWN. Do not replay. Inspect get_command_status.`
    );
  }

  async pendingStatus(acknowledge = false): Promise<{state: string; requestId?: string; result?: IpcResult}> {
    await this.mutex.acquire();
    try { return await this.pendingStatusInternal(acknowledge); }
    finally { this.mutex.release(); }
  }

  private async discoverPending(): Promise<void> {
    const latch = path.join(this.config.baseDir, 'uncertain.json');
    if (fs.existsSync(latch)) return;
    const pending = fs.existsSync(this.commandsDir)
      ? fs.readdirSync(this.commandsDir).filter(n => /\.(command|running)\.json$/.test(n)).sort() : [];
    // The watcher can finish after Node exits but before a timeout latch was
    // written. Preserve that undelivered outcome as well as running requests.
    const undelivered = this.config.deleteResultAfterRead && fs.existsSync(this.resultsDir)
      ? fs.readdirSync(this.resultsDir).filter(n => n.endsWith('.result.json')).sort() : [];
    const file = pending[0] ?? undelivered[0];
    if (file) {
      const requestId = file.replace(/\.(command|running|result)\.json$/, '');
      await atomicWrite(latch, JSON.stringify({requestId, timestamp: Date.now(), reason: 'Request retained after reconnect'}));
    }
  }

  private async pendingStatusInternal(acknowledge: boolean): Promise<{state: string; requestId?: string; result?: IpcResult}> {
    await this.discoverPending();
    const latch = path.join(this.config.baseDir, 'uncertain.json');
    if (!fs.existsSync(latch)) return {state: 'clear'};
    const {requestId} = JSON.parse(fs.readFileSync(latch, 'utf8'));
    if (typeof requestId !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(requestId)) throw new Error('Invalid pending request.');
    const resultPath = path.join(this.resultsDir, `${requestId}.result.json`);
    const result = fs.existsSync(resultPath) ? await this._readResultWithRetry(resultPath, requestId) : null;
    if (!result) return {state: 'unknown', requestId};
    if (acknowledge) {
      // Retire dispatch files before clearing the latch. Never replay them.
      for (const suffix of ['command.json', 'running.json', 'py']) {
        fs.rmSync(path.join(this.commandsDir, `${requestId}.${suffix}`), {force: true});
      }
      fs.unlinkSync(latch);
      try { fs.unlinkSync(resultPath); } catch { /* already acknowledged */ }
    }
    return {state: acknowledge ? 'acknowledged' : 'completed', requestId, result};
  }

  /**
   * Read result file with retry for corrupted/partial JSON.
   * Up to 3 attempts with 100ms delay between.
   */
  private async _readResultWithRetry(
    resultPath: string,
    requestId: string
  ): Promise<IpcResult | null> {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const content = fs.readFileSync(resultPath, 'utf-8');
        const result: IpcResult = JSON.parse(content);
        if (result.requestId === requestId && typeof result.success === 'boolean'
          && typeof result.output === 'string' && typeof result.error === 'string'
          && typeof result.timestamp === 'number') {
          return result;
        }
        ipcLog.warn(
          `Result file requestId mismatch: expected ${requestId}, got ${result.requestId}`
        );
        return null;
      } catch (err) {
        if (attempt < 2) {
          ipcLog.debug(
            `Result read attempt ${attempt + 1} failed, retrying in 100ms...`
          );
          await this._sleep(100);
        } else {
          ipcLog.warn(
            `Failed to read result after 3 attempts for ${requestId}: ${err}`
          );
          return null;
        }
      }
    }
    return null;
  }

  /** Clean up command files for a given request */
  private _cleanupCommandFiles(requestId: string): boolean {
    const scriptPath = path.join(this.commandsDir, `${requestId}.py`);
    const commandPath = path.join(
      this.commandsDir,
      `${requestId}.command.json`
    );
    try {
      for (const file of [scriptPath, commandPath, path.join(this.commandsDir, `${requestId}.running.json`)]) {
        fs.rmSync(file, {force: true});
      }
      return true;
    } catch { return false; }
  }

  /** Remove the entire session directory */
  async cleanup(): Promise<void> {
    try {
      fs.rmSync(this.config.baseDir, { recursive: true, force: true });
      ipcLog.info(`Session directory cleaned up: ${this.config.baseDir}`);
    } catch (err) {
      ipcLog.warn(`Failed to clean up session directory: ${err}`);
    }
  }

  private _sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
