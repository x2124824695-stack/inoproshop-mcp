import {afterEach, describe, expect, it} from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {CodesysLauncher} from '../src/launcher';
import {HeadlessExecutor} from '../src/headless';
import {ScriptManager} from '../src/script-manager';
import {WATCHER_VERSION} from '../src/protocol';

const sessions: CodesysLauncher[]=[];
const roots: string[]=[];
afterEach(()=>{
  for (const launcher of sessions.splice(0)) {
    launcher.detach();
    const ipc=launcher.getStatus().ipcDir!;
    if (path.dirname(ipc)!==path.join(os.tmpdir(),'inoproshop-mcp-v1')) throw new Error('Unsafe test cleanup');
    fs.rmSync(ipc,{recursive:true,force:true});
  }
  for (const root of roots.splice(0)) fs.rmSync(root,{recursive:true,force:true});
});
function session() {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'mcp-attach-test-'));
  roots.push(root);
  const project=path.join(root,'中文.project'); fs.writeFileSync(project,'unchanged');
  const config={codesysPath:process.execPath,profileName:'TEST-ATTACH',workspaceDir:root,timeoutMs:100};
  const launcher=new CodesysLauncher(config); sessions.push(launcher);
  return {root,project,config,launcher,ipc:launcher.getStatus().ipcDir!};
}
function publish(ipc:string,pid=process.pid) {
  const prepared=JSON.parse(fs.readFileSync(path.join(ipc,'attachment.json'),'utf8'));
  const meta={...prepared,pid,version:WATCHER_VERSION,attached:true,startedAt:Date.now()};
  fs.writeFileSync(path.join(ipc,'session.json'),JSON.stringify(meta));
  fs.writeFileSync(path.join(ipc,'ready.signal'),JSON.stringify({pid,version:WATCHER_VERSION,sessionToken:prepared.token}));
  return meta;
}
describe('manually opened IDE attachment',()=>{
  it('prepares a UTF-8 bootstrap without changing the project, and prevents a second IDE launch',async()=>{
    const {launcher,project,ipc}=session();
    const prepared=await launcher.prepareAttachment(project);
    const source=fs.readFileSync(prepared.scriptPath,'utf8');
    expect(source.startsWith('# -*- coding: utf-8 -*-\nfrom __future__ import unicode_literals\n')).toBe(true);
    expect(source).toContain('中文.project');
    expect(source).toContain('Process.GetCurrentProcess');
    expect(source).not.toMatch(/projects\.(open|create)|\.save\(/);
    expect(fs.readFileSync(project,'utf8')).toBe('unchanged');
    expect(fs.existsSync(path.join(ipc,'session.json'))).toBe(false);
    await expect(launcher.attach()).rejects.toThrow('not ready');
    await expect(launcher.launch()).rejects.toThrow('will not start a second IDE');
  });
  it('connects and reconnects to the same PID and watcher token',async()=>{
    const {launcher,project,ipc,config}=session();
    await launcher.prepareAttachment(project); const meta=publish(ipc);
    await launcher.attach(); expect(launcher.getStatus()).toMatchObject({state:'ready',pid:process.pid});
    const first=launcher.getStatus().sessionId;
    launcher.detach();
    const reconnect=new CodesysLauncher(config); sessions.push(reconnect);
    await reconnect.attach(); expect(reconnect.getStatus()).toMatchObject({state:'ready',sessionId:first});
    expect(JSON.parse(fs.readFileSync(path.join(ipc,'session.json'),'utf8')).token).toBe(meta.token);
  });
  it.each(['identity','token','version','pid'])('rejects mismatched %s before connecting',async(field)=>{
    const {launcher,project,ipc}=session(); await launcher.prepareAttachment(project);
    const meta:any=publish(ipc); meta[field]=field==='pid'?0:'wrong';
    fs.writeFileSync(path.join(ipc,'session.json'),JSON.stringify(meta));
    await expect(launcher.attach()).rejects.toThrow('mismatch');
    expect(launcher.getStatus().state).not.toBe('ready');
  });
  it('preserves unresolved requests and rejects competing servers',async()=>{
    const {launcher,project,ipc,config}=session(); await launcher.prepareAttachment(project);
    const rival=new CodesysLauncher(config); sessions.push(rival);
    await expect(rival.prepareAttachment(project)).rejects.toThrow('Another MCP server');
    const id='00000000-0000-0000-0000-000000000001';
    fs.writeFileSync(path.join(ipc,'commands',id+'.running.json'),'{}');
    await expect(launcher.prepareAttachment(project)).rejects.toThrow('unresolved');
    expect(fs.existsSync(path.join(ipc,'commands',id+'.running.json'))).toBe(true);
  });
  it('rejects project reads in stateless headless mode with useful instructions',async()=>{
    const {config}=session(); const executor=new HeadlessExecutor(config);
    const source=new ScriptManager(path.resolve('src/scripts')).prepareScriptWithHelpers('get_all_pou_code',
      {PROJECT_FILE_PATH:'test.project'},['_text_utils','require_project_open']);
    await expect(executor.executeScript(source)).rejects.toThrow('prepare_existing_session and attach_codesys');
  });
});
