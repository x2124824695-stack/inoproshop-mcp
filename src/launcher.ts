import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {createHash, randomUUID} from 'crypto';
import {spawn} from 'child_process';
import {LauncherConfig, LauncherStatus, CodesysState, IpcResult, ScriptExecutor} from './types';
import {IpcClient, DEFAULT_IPC_CONFIG} from './ipc';
import {ScriptManager} from './script-manager';

import {WATCHER_VERSION, SESSION_NAMESPACE} from './protocol';
export {WATCHER_VERSION} from './protocol';
export function sessionIdentity(c: LauncherConfig): string {
  return createHash('sha256').update(JSON.stringify([path.resolve(c.codesysPath).toLowerCase(), c.profileName,
    fs.realpathSync(c.workspaceDir).toLowerCase(), SESSION_NAMESPACE])).digest('hex').slice(0,24);
}
function alive(pid: number): boolean {try {process.kill(pid,0); return true;} catch {return false;}}

/** Exclusive ownership; explicit identity; never kills another IDE. */
export class CodesysLauncher implements ScriptExecutor {
  private state: CodesysState = 'stopped';
  private pid: number | null = null;
  private ipcClient: IpcClient | null = null;
  private startedAt: number | null = null;
  private lastError: string | null = null;
  private launching?: Promise<void>;
  private lockToken = randomUUID();
  private ownsLock = false;
  private sessionId: string;
  private ipcDir: string;
  private lockPath: string;
  constructor(private config: LauncherConfig) {
    this.sessionId = sessionIdentity(config);
    this.ipcDir = path.join(os.tmpdir(),'inoproshop-mcp-v1',this.sessionId);
    this.lockPath = this.ipcDir+'.owner.json';
  }
  private claim(): void {
    if(this.ownsLock) return;
    fs.mkdirSync(path.dirname(this.lockPath),{recursive:true});
    for(let attempt=0;attempt<2;attempt++) {
      try {
        fs.writeFileSync(this.lockPath,JSON.stringify({pid:process.pid,token:this.lockToken}),{flag:'wx'});
        this.ownsLock=true; return;
      } catch(e:any) {
        if(e.code!=='EEXIST') throw e;
        let owner;
        try {owner=JSON.parse(fs.readFileSync(this.lockPath,'utf8'));}
        catch {throw new Error('Session lock is incomplete. Retry after the other server starts.');}
        if(!Number.isInteger(owner.pid)||alive(owner.pid)) throw new Error('Another MCP server owns this session.');
        try {fs.unlinkSync(this.lockPath);} catch {/* another contender won */}
      }
    }
    throw new Error('Could not claim session ownership.');
  }
  detach():void {
    if(this.ownsLock) {
      try {if(JSON.parse(fs.readFileSync(this.lockPath,'utf8')).token===this.lockToken) fs.unlinkSync(this.lockPath);} catch {}
      this.ownsLock=false;
    }
  }
  /** Bootstrap a watcher in a manually opened IDE; never starts a second IDE. */
  async prepareAttachment(projectFilePath: string): Promise<{scriptPath: string; sessionId: string}> {
    if (this.launching) throw new Error('IDE launch is in progress.');
    this.claim();
    fs.mkdirSync(this.ipcDir, {recursive:true});
    let meta:any;
    try {meta=JSON.parse(fs.readFileSync(path.join(this.ipcDir,'session.json'),'utf8'));} catch {meta=null;}
    if (meta?.pid && alive(meta.pid)) throw new Error('A live session already exists. Call attach_codesys or launch_codesys; do not run another watcher.');
    this.ipcClient=this.makeClient(meta?.token || 'unavailable');
    if ((await this.ipcClient.pendingStatus()).state!=='clear') throw new Error('Previous session has an unresolved command. Inspect get_command_status before attaching.');
    const token=randomUUID();
    this.ipcClient=this.makeClient(token);
    await this.ipcClient.ensureDirectories();
    for (const name of ['ready.signal','terminate.signal']) {try {fs.unlinkSync(path.join(this.ipcDir,name));} catch {}}
    const scriptPath=path.join(this.ipcDir,'attach-watcher.py');
    fs.writeFileSync(path.join(this.ipcDir,'attachment.json'), JSON.stringify({identity:this.sessionId,token,projectFilePath}), 'utf8');
    fs.writeFileSync(scriptPath, new ScriptManager().prepareScriptWithHelpers('watcher', {
      IPC_BASE_DIR:this.ipcDir, SESSION_TOKEN:token, WATCHER_VERSION,
      SESSION_ID:this.sessionId, CODESYS_PATH:path.resolve(this.config.codesysPath), PROJECT_FILE_PATH:projectFilePath,
    }, ['attach_session']), 'utf8');
    return {scriptPath,sessionId:this.sessionId};
  }
  /** Connect only after the bootstrap proved the IDE executable and open project. */
  async attach(): Promise<void> {
    if (this.launching) throw new Error('IDE launch is in progress.');
    this.claim();
    let meta:any, ready:any, prepared:any;
    try {
      meta=JSON.parse(fs.readFileSync(path.join(this.ipcDir,'session.json'),'utf8'));
      ready=JSON.parse(fs.readFileSync(path.join(this.ipcDir,'ready.signal'),'utf8'));
      prepared=JSON.parse(fs.readFileSync(path.join(this.ipcDir,'attachment.json'),'utf8'));
    } catch {throw new Error('Existing IDE watcher is not ready. Call prepare_existing_session, run its script in the target IDE, then attach_codesys.');}
    if (!meta.attached || meta.identity!==this.sessionId || meta.version!==WATCHER_VERSION || !meta.token ||
        prepared.identity!==this.sessionId || prepared.token!==meta.token || ready.sessionToken!==meta.token ||
        ready.version!==WATCHER_VERSION || ready.pid!==meta.pid || !Number.isInteger(meta.pid) || !alive(meta.pid)) {
      throw new Error('Existing IDE session identity, token, version or PID mismatch; no IDE was started.');
    }
    if (fs.existsSync(path.join(this.ipcDir,'terminate.signal'))) throw new Error('Existing IDE watcher was stopped; no new IDE was started.');
    this.pid=meta.pid; this.startedAt=meta.startedAt; this.ipcClient=this.makeClient(meta.token);
    this.state='ready'; this.lastError=null;
  }
  async launch():Promise<void> {
    if(this.launching) return this.launching;
    if(this.state==='ready'&&this.isRunning()) return;
    this.launching=this.doLaunch();
    try {await this.launching;} catch(e) {this.lastError=String(e); this.state='error'; throw e;}
    finally {this.launching=undefined;}
  }
  private async doLaunch():Promise<void> {
    this.claim(); this.state='launching';
    fs.mkdirSync(this.ipcDir,{recursive:true});
    const metaPath=path.join(this.ipcDir,'session.json');
    let meta:any;
    try {meta=JSON.parse(fs.readFileSync(metaPath,'utf8'));} catch {meta=null;}
    if(meta?.pid&&alive(meta.pid)) {
      if(meta.identity!==this.sessionId||!meta.token) throw new Error('Live session identity mismatch.');
      this.pid=meta.pid; this.ipcClient=this.makeClient(meta.token); this.startedAt=meta.startedAt;
      if(meta.version!==WATCHER_VERSION) throw new Error(`Live watcher ${meta.version} requires upgrade to ${WATCHER_VERSION}. IDE left intact. Resolve pending results, then save and close that IDE manually before launch_codesys. No second IDE was started.`);
      if(fs.existsSync(path.join(this.ipcDir,'terminate.signal'))) throw new Error('Watcher was shut down. Close this IDE manually before launching a new session.');
      await this.waitReady(); this.state='ready'; this.lastError=null; return;
    }
    if(fs.existsSync(path.join(this.ipcDir,'attachment.json'))) throw new Error('An existing-IDE attachment is prepared. Run attach-watcher.py in that IDE and call attach_codesys; launch_codesys will not start a second IDE.');
    this.ipcClient=this.makeClient(meta?.token||'unavailable');
    if((await this.ipcClient.pendingStatus()).state!=='clear') {
      throw new Error('Previous session has an unresolved command. Inspect get_command_status and verify the project; no commands will be replayed.');
    }
    if(!fs.existsSync(this.config.codesysPath)) throw new Error('InoProShop executable not found.');
    for(const name of ['commands','results']) {
      const dir=path.join(this.ipcDir,name);
      if(fs.existsSync(dir)&&fs.readdirSync(dir).length) fs.renameSync(dir,path.join(this.ipcDir,name+'-retired-'+randomUUID()));
    }
    for(const name of ['ready.signal','terminate.signal']) {try {fs.unlinkSync(path.join(this.ipcDir,name));} catch {}}
    const token=randomUUID(); this.ipcClient=this.makeClient(token); await this.ipcClient.ensureDirectories();
    const watcherPath=path.join(this.ipcDir,'watcher.py');
    fs.writeFileSync(watcherPath,new ScriptManager().prepareScript('watcher',{IPC_BASE_DIR:this.ipcDir,SESSION_TOKEN:token,WATCHER_VERSION}),'utf8');
    const child=spawn(this.config.codesysPath,[`--profile=${this.config.profileName}`,`--runscript=${watcherPath}`],{
      detached:true,shell:false,windowsHide:false,stdio:'ignore',cwd:path.dirname(this.config.codesysPath),
    });
    this.pid=child.pid??null; child.unref();
    child.on('error',e=>{this.lastError=e.message;this.state='error';});
    child.on('exit',()=>{if(this.pid===child.pid){this.pid=null;this.state='stopped';}});
    this.startedAt=Date.now();
    fs.writeFileSync(metaPath,JSON.stringify({pid:this.pid,token,identity:this.sessionId,version:WATCHER_VERSION,startedAt:this.startedAt}),'utf8');
    await this.waitReady(); this.state='ready'; this.lastError=null;
  }
  private makeClient(token:string) {return new IpcClient({...DEFAULT_IPC_CONFIG,baseDir:this.ipcDir,sessionToken:token,
    commandTimeoutMs:this.config.timeoutMs??DEFAULT_IPC_CONFIG.commandTimeoutMs});}
  private async waitReady():Promise<void> {
    const timeout=Number(process.env.CODESYS_MCP_READY_TIMEOUT_MS)||180000, start=Date.now();
    while(Date.now()-start<timeout) {
      if(this.state==='error'||!this.isRunning()) throw new Error(this.lastError||'IDE exited before readiness.');
      if(await this.ipcClient!.isReady()) return;
      await new Promise(r=>setTimeout(r,250));
    }
    throw new Error('Watcher startup timed out. IDE left intact; retry launch_codesys once ready.');
  }
  async executeScript(content:string,timeoutMs?:number):Promise<IpcResult> {
    if(this.launching) await this.launching;
    if(this.state!=='ready'||!this.ipcClient||!this.isRunning()||!this.ownsLock) throw new Error('Persistent session not ready; call launch_codesys. No automatic headless fallback.');
    return this.ipcClient.sendCommand(content,timeoutMs);
  }
  async pendingStatus(acknowledge=false) {return this.ipcClient?this.ipcClient.pendingStatus(acknowledge):{state:'unavailable'};}
  async shutdown():Promise<void> {
    if(!this.ipcClient||!this.isRunning()){this.detach();this.state='stopped';return;}
    const r=await this.executeScript(new ScriptManager().prepareScript('save_primary_for_shutdown',{}));
    if(!r.success) throw new Error(`Project save failed or could not be verified; IDE left open. ${r.error || r.output}`);
    await this.ipcClient.sendTerminate(); this.detach(); this.state='stopped';
  }
  isRunning():boolean {return this.pid!==null&&alive(this.pid);}
  getStatus():LauncherStatus {
    if(this.state==='ready'&&!this.isRunning()) this.state='error';
    return {state:this.state,pid:this.pid,sessionId:this.sessionId,ipcDir:this.ipcDir,startedAt:this.startedAt,lastError:this.lastError};
  }
}
