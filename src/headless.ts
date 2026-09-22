/**
 * Headless fallback mode — spawns CODESYS with --noUI per command.
 * Direct port of the original codesys_interop.js approach.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawn } from 'child_process';
import { LauncherConfig, IpcResult, ScriptExecutor } from './types';
import { headlessLog } from './logger';
import { SerialQueue } from './serial';

const SCRIPT_SUCCESS_MARKER = 'SCRIPT_SUCCESS';
const SCRIPT_ERROR_MARKER = 'SCRIPT_ERROR';
const DEFAULT_TIMEOUT_MS = 60_000;

export class HeadlessExecutor implements ScriptExecutor {
  private config: LauncherConfig;
  private queue = new SerialQueue();
  private poisoned = false;

  constructor(config: LauncherConfig) {
    this.config = config;

    // Validate CODESYS exe exists
    if (!fs.existsSync(config.codesysPath)) {
      throw new Error(
        `CODESYS executable not found: ${config.codesysPath}`
      );
    }
  }

  /** Execute a script by spawning CODESYS with --noUI */
  executeScript(content: string, timeoutMs?: number): Promise<IpcResult> {
    return this.queue.run(() => this.runScript(content, timeoutMs));
  }

  private async runScript(
    scriptContent: string,
    timeoutMs?: number
  ): Promise<IpcResult> {
    if (this.poisoned) throw new Error('Headless execution timed out; inspect the IDE/process and restart the server before further commands.');
    const timeout = timeoutMs ?? this.config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const tempDir = os.tmpdir();
    const tempFileName = `codesys_script_${Date.now()}_${Math.random()
      .toString(36)
      .substring(2, 9)}.py`;
    const tempFilePath = path.join(tempDir, tempFileName);

    const requestId = `headless_${Date.now()}`;
    const codesysDir = path.dirname(this.config.codesysPath);

    try {
      // Write script to temp file
      const normalized = scriptContent.replace(/\r\n/g, '\n');
      fs.writeFileSync(tempFilePath, '# -*- coding: utf-8 -*-\n' + normalized, 'utf8');
      headlessLog.debug(`Temp script written: ${tempFilePath}`);

      // Build command
      const quotedExe = `"${this.config.codesysPath}"`;
      const profileArg = `--profile="${this.config.profileName}"`;
      const scriptArg = `--runscript="${tempFilePath}"`;
      const fullCommand = `${quotedExe} ${profileArg} --noUI ${scriptArg}`;

      headlessLog.debug(`Spawning: ${fullCommand}`);

      // Spawn and collect output
      const result = await new Promise<{
        code: number | null;
        stdout: string;
        stderr: string;
        error?: Error;
      }>((resolve) => {
        let stdoutData = '';
        let stderrData = '';
        const controller = new AbortController();

        // Prepend CODESYS dir to PATH
        const spawnEnv = { ...process.env };
        const originalPath = spawnEnv.PATH || '';
        spawnEnv.PATH = `${codesysDir};${originalPath}`;

        const child = spawn(this.config.codesysPath, [`--profile=${this.config.profileName}`, '--noUI', `--runscript=${tempFilePath}`], {
          windowsHide: true,
          signal: controller.signal,
          cwd: codesysDir,
          env: spawnEnv,
          shell: false,
        });

        const timeoutId = setTimeout(() => {
          this.poisoned = true;
          headlessLog.warn('Process timeout reached');
          controller.abort();
        }, timeout);

        child.stdout.on('data', (data: Buffer) => {
          stdoutData += data.toString();
        });

        child.stderr.on('data', (data: Buffer) => {
          stderrData += data.toString();
        });

        child.on('error', (err: Error) => {
          clearTimeout(timeoutId);
          resolve({ code: 1, stdout: stdoutData, stderr: stderrData, error: err });
        });

        child.on('close', (code: number | null) => {
          clearTimeout(timeoutId);
          resolve({ code, stdout: stdoutData, stderr: stderrData });
        });

        controller.signal.addEventListener(
          'abort',
          () => {
            if (!child.killed) {
              child.kill('SIGTERM');
              setTimeout(() => {
                if (!child.killed) child.kill('SIGKILL');
              }, 2_000);
            }
            resolve({
              code: null,
              stdout: stdoutData,
              stderr: stderrData + '\nTIMEOUT: Process aborted.',
            });
          },
          { once: true }
        );
      });

      // Determine success
      let success = false;
      const combinedOutput = result.stdout;
      const stderrOutput = result.stderr;

      if (result.error) {
        success = false;
      } else if (/^SCRIPT_ERROR(?:\s*:.*)?\s*$/m.test(combinedOutput + '\n' + stderrOutput)) {
        success = false;
      } else {
        success = result.code === 0 && /^SCRIPT_SUCCESS(?:\s*:.*)?\s*$/m.test(combinedOutput + '\n' + stderrOutput);
      }

      const finalOutput = success
        ? combinedOutput
        : `${stderrOutput}\n${combinedOutput}`.trim();

      return {
        requestId,
        success,
        output: finalOutput,
        error: success ? '' : (result.error?.message || stderrOutput || `Exit code ${result.code}`),
        timestamp: Date.now(),
      };
    } finally {
      // Clean up temp file
      try {
        fs.unlinkSync(tempFilePath);
      } catch {
        headlessLog.debug(`Failed to delete temp file: ${tempFilePath}`);
      }
    }
  }
}
