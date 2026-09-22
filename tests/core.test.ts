import {describe,it,expect,afterEach} from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {ScriptManager} from '../src/script-manager';
import {compileResponse,scriptSucceeded,normalizeToolResponse,searchCoverage} from '../src/results';
import {WATCHER_VERSION} from '../src/protocol';
import {parseResultJson} from '../src/result-parser';
import {SerialQueue} from '../src/serial';
import {workspacePath,toolAllowed,guardedTools} from '../src/policy';
import {IpcClient,DEFAULT_IPC_CONFIG} from '../src/ipc';
import {sessionIdentity} from '../src/launcher';
import type {ServerConfig} from '../src/types';

const dirs:string[]=[];
function temp(){const p=fs.mkdtempSync(path.join(os.tmpdir(),'inoproshop-mcp-test-'));dirs.push(p);return p;}
afterEach(()=>{for(const p of dirs.splice(0)){if(!path.basename(p).startsWith('inoproshop-mcp-test-'))throw new Error('Unsafe test cleanup');fs.rmSync(p,{recursive:true,force:true});}});
const config=(workspaceDir:string):ServerConfig=>({codesysPath:process.execPath,profileName:'Test',workspaceDir,autoLaunch:false,keepAlive:true,
  timeoutMs:60000,verbose:false,debug:false,mode:'persistent'});

describe('script data boundaries',()=>{
  it('generated Python uses unicode literals and escapes control characters',()=>{
    const m=new ScriptManager(path.resolve('src/scripts'));
    expect(m.prepareScript('watcher',{IPC_BASE_DIR:'C:/中文',SESSION_TOKEN:'x',WATCHER_VERSION})).toContain('from __future__ import unicode_literals');
    expect(m.interpolate('"{VALUE}"',{VALUE:'a\0\x01\x0b\x0c'})).toBe('"a\\x00\\x01\\x0b\\x0c"');
    expect(()=>m.loadTemplate('../server')).toThrow('Invalid');
  });
  it('does not re-interpolate template tokens embedded in ST',()=>{
    const m=new ScriptManager();expect(m.interpolate('"{CODE}" "{FLAG}"',{CODE:'中文 {FLAG} $&',FLAG:'1'})).toBe('"中文 {FLAG} $&" "1"');
  });
  it('escapes quotes, Windows paths, CRLF, and triple quotes',()=>{
    const m=new ScriptManager();expect(m.interpolate('"{CODE}"',{CODE:'"""\r\nC:\\中文'})).toBe('"\\"\\"\\"\\r\\nC:\\\\中文"');
  });
  it('rejects missing parameters',()=>expect(()=>new ScriptManager().interpolate('{MISSING}',{})).toThrow('Missing'));
  it('read tools require the already-open project',()=>{
    const m=new ScriptManager(path.resolve('src/scripts'));
    const s=m.prepareScriptWithHelpers('get_all_pou_code',{PROJECT_FILE_PATH:'C:/a.project'},['_text_utils','ensure_project_open']);
    expect(s).toContain('def require_project_open');expect(s).not.toContain('def ensure_project_open');
  });
});
describe('truthful outcomes',()=>{
  it('malformed search data fails and incomplete coverage is explicit',()=>{
    expect(()=>searchCoverage({hits:[],count:2,truncated:false})).toThrow('schema');
    expect(searchCoverage({hits:[],count:0,truncated:false,complete:false})).toContain('incomplete');
  });
  it('normalizes text, JSON, legacy structured data and failures without losing payloads',()=>{
    const response=(text:string,extra={})=>normalizeToolResponse({content:[{type:'text',text}],...extra},'test','id');
    expect(response('{"hits":[]}').structuredContent.result).toEqual({hits:[]});
    expect(response('ok',{structuredContent:{result:{hits:[1]}}}).structuredContent.result).toEqual({hits:[1]});
    expect(response('failure',{isError:true}).structuredContent).toMatchObject({ok:false,error:{message:'failure'}});
    expect(response('compile',{structuredContent:{verified:true}}).structuredContent.verified).toBe(true);
  });
  const block=(value:unknown)=>'### COMPILE_MESSAGES_START ###\n'+JSON.stringify(value)+'\n### COMPILE_MESSAGES_END ###\nSCRIPT_SUCCESS: build';
  it('fatal errors fail compilation',()=>expect(compileResponse(block([{severity:'fatal',text:'broken'}]),true).isError).toBe(true));
  it('empty verified diagnostics succeed',()=>expect(compileResponse(block([]),true).isError).toBe(false));
  it('missing or malformed diagnostics fail closed',()=>{
    expect(compileResponse('SCRIPT_SUCCESS: initiated',true).isError).toBe(true);
    expect(compileResponse(block({messages:[]}),true).isError).toBe(true);
    expect(compileResponse(block([{severity:'unknown',text:'?'}]),true).isError).toBe(true);
  });
  it('error takes precedence over success and embedded substrings are not status',()=>{
    expect(scriptSucceeded({success:true,output:'SCRIPT_SUCCESS: done\nSCRIPT_ERROR: fail'})).toBe(false);
    expect(scriptSucceeded({success:true,output:'{"source":"SCRIPT_SUCCESS"}'})).toBe(false);
    expect(scriptSucceeded({success:true,output:'{"source":"SCRIPT_ERROR"}\nSCRIPT_SUCCESS: done'})).toBe(true);
  });
  it('JSON result marker text inside user data does not split the frame',()=>{
    const value={text:'### RESULT_JSON ###\n### END_RESULT_JSON ### 中文'};
    expect(parseResultJson('log\n### RESULT_JSON ###\n'+JSON.stringify(value)+'\n### END_RESULT_JSON ###\n')).toEqual({ok:true,data:value});
  });
});
describe('operation policy',()=>{
  it('rejects workspace traversal and sibling-prefix confusion',()=>{
    const root=temp();expect(workspacePath('子目录/p.project',root)).toBe(path.join(root,'子目录/p.project'));
    expect(()=>workspacePath('../outside.project',root)).toThrow('outside');
    expect(()=>workspacePath(root+'-other/x.project',root)).toThrow('outside');
  });
  it('validates every filesystem argument used by public tools',()=>{
    const root=temp(), handlers:Record<string,any>={};
    const s=guardedTools({tool:(n:string,...a:any[])=>handlers[n]=a.at(-1)},config(root),new SerialQueue());
    s.tool('list_project_templates','test',{},async()=>({content:[],isError:false}));
    s.tool('create_project_archive','test',{},async()=>({content:[],isError:false}));
    return Promise.all([
      handlers.list_project_templates({extraTemplateDir:'../outside'},{}),
      handlers.create_project_archive({projectFilePath:'x.project',outputPath:'../outside.arc'},{}),
    ]).then(results=>expect(results.every(r=>r.isError)).toBe(true));
  });
  it('does not expose online or arbitrary Python by default',()=>{
    const c=config(temp());expect(toolAllowed('write_variable',c)).toBe(false);expect(toolAllowed('eval_python',c)).toBe(false);
    expect(toolAllowed('set_pou_code',c)).toBe(true);expect(toolAllowed('set_pou_code',{...c,readOnly:true})).toBe(false);
    expect(toolAllowed('recover_session',{...c,readOnly:true})).toBe(true);
    expect(toolAllowed('shutdown_codesys',{...c,readOnly:true})).toBe(false);
  });
  it('serializes calls and recovers queue after rejection',async()=>{
    const q=new SerialQueue(),seen:number[]=[];
    const a=q.run(async()=>{seen.push(1);await new Promise(r=>setTimeout(r,10));throw new Error('x');});
    const b=q.run(async()=>{seen.push(2);return 2;});
    await expect(a).rejects.toThrow('x');await expect(b).resolves.toBe(2);expect(seen).toEqual([1,2]);
  });
  it('snapshots before writes and audit omits code and credentials',async()=>{
    const root=temp(),project=path.join(root,'test.project');fs.writeFileSync(project,'old');
    const handlers:Record<string,any>={};
    const s=guardedTools({tool:(n:string,...a:any[])=>handlers[n]=a.at(-1)},config(root),new SerialQueue());
    s.tool('set_pou_code','test',{},async()=>{fs.writeFileSync(project,'new');return {content:[],isError:false};});
    await handlers.set_pou_code({projectFilePath:project,implementationCode:'SECRET_CODE',password:'SECRET_PASS'},{});
    const backupDir=path.join(root,'.inoproshop-mcp/backups');
    expect(fs.readFileSync(path.join(backupDir,fs.readdirSync(backupDir)[0]),'utf8')).toBe('old');
    expect(fs.readFileSync(path.join(root,'.inoproshop-mcp/audit.jsonl'),'utf8')).not.toContain('SECRET');
  });
  it('session identity separates profile and workspace',()=>{
    const c=config(temp());expect(sessionIdentity(c)).not.toBe(sessionIdentity({...c,profileName:'Other'}));
    expect(sessionIdentity(c)).not.toBe(sessionIdentity({...c,workspaceDir:temp()}));
  });
});
describe('IPC outcome reconciliation',()=>{
  function client(){const baseDir=temp();return {baseDir,ipc:new IpcClient({...DEFAULT_IPC_CONFIG,baseDir,sessionToken:'token',commandTimeoutMs:30,pollIntervalMs:2,maxPollIntervalMs:5})};}
  it('rejects stale ready signals and accepts version/token match',async()=>{
    const {baseDir,ipc}=client();fs.writeFileSync(path.join(baseDir,'ready.signal'),'{}');expect(await ipc.isReady()).toBe(false);
    fs.writeFileSync(path.join(baseDir,'ready.signal'),JSON.stringify({version:'1.0.0',sessionToken:'token'}));expect(await ipc.isReady()).toBe(false);
    fs.writeFileSync(path.join(baseDir,'ready.signal'),JSON.stringify({version:WATCHER_VERSION,sessionToken:'token'}));expect(await ipc.isReady()).toBe(true);
  });
  it('timeout blocks new writes and late result requires acknowledgement',async()=>{
    const {baseDir,ipc}=client();await ipc.ensureDirectories();
    await expect(ipc.sendCommand('print("x")')).rejects.toThrow('UNKNOWN');
    const state=await ipc.pendingStatus();expect(state.state).toBe('unknown');
    await expect(ipc.sendCommand('NEVER_SEND')).rejects.toThrow('previous command');
    const command=JSON.parse(fs.readFileSync(path.join(baseDir,'commands',state.requestId+'.command.json'),'utf8'));
    expect(command.sessionToken).toBe('token');expect(command.deadline).toBeGreaterThan(0);
    fs.writeFileSync(path.join(baseDir,'results',state.requestId+'.result.json'),JSON.stringify({requestId:state.requestId,success:true,output:'SCRIPT_SUCCESS',error:'',timestamp:Date.now()}));
    expect((await ipc.pendingStatus()).state).toBe('completed');
    expect((await ipc.pendingStatus(true)).state).toBe('acknowledged');
    expect((await ipc.pendingStatus()).state).toBe('clear');
  });
  it('reconnect discovers a claimed command even if the old client never wrote a timeout latch',async()=>{
    const {baseDir,ipc}=client();await ipc.ensureDirectories();
    const id='00000000-0000-0000-0000-000000000001';
    fs.writeFileSync(path.join(baseDir,'commands',id+'.running.json'),'{}');
    expect(await ipc.pendingStatus(true)).toMatchObject({state:'unknown',requestId:id});
    await expect(ipc.sendCommand('NEVER_SEND')).rejects.toThrow('previous command');
    fs.writeFileSync(path.join(baseDir,'results',id+'.result.json'),JSON.stringify({requestId:id,success:false,output:'',error:'中文失败',timestamp:Date.now()}));
    expect((await ipc.pendingStatus(true)).state).toBe('acknowledged');
    expect(fs.existsSync(path.join(baseDir,'commands',id+'.running.json'))).toBe(false);
  });
  it('a successful result retires dispatch records before removing the result',async()=>{
    const {baseDir,ipc}=client();await ipc.ensureDirectories();
    const respond=setInterval(()=>{
      const file=fs.readdirSync(path.join(baseDir,'commands')).find(n=>n.endsWith('.command.json'));
      if(!file)return;
      const id=file.replace('.command.json','');
      fs.renameSync(path.join(baseDir,'commands',file),path.join(baseDir,'commands',id+'.running.json'));
      fs.writeFileSync(path.join(baseDir,'results',id+'.result.json'),JSON.stringify({requestId:id,success:true,output:'SCRIPT_SUCCESS',error:'',timestamp:Date.now()}));
    },1);
    try {
      expect((await ipc.sendCommand('test',500)).success).toBe(true);
      expect((await ipc.pendingStatus()).state).toBe('clear');
      expect((await ipc.sendCommand('second',500)).success).toBe(true);
    } finally { clearInterval(respond); }
  });
  it('reconnect retains a completed result that the previous client never consumed',async()=>{
    const {baseDir,ipc}=client();await ipc.ensureDirectories();
    const id='00000000-0000-0000-0000-000000000002';
    fs.writeFileSync(path.join(baseDir,'results',id+'.result.json'),JSON.stringify({requestId:id,success:true,output:'SCRIPT_SUCCESS',error:'',timestamp:Date.now()}));
    expect(await ipc.pendingStatus()).toMatchObject({state:'completed',requestId:id});
    await expect(ipc.sendCommand('NEVER_REPLAY')).rejects.toThrow('previous command');
    expect((await ipc.pendingStatus(true)).state).toBe('acknowledged');
    expect((await ipc.pendingStatus()).state).toBe('clear');
  });
});
