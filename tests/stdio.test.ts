import {it,expect} from 'vitest';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

it('stdio handshake, discovery, policies and unavailable IDE are truthful without launching any IDE',async()=>{
  const workspace=fs.mkdtempSync(path.join(os.tmpdir(),'inoproshop-stdio-'));
  const transport=new StdioClientTransport({command:process.execPath,args:[path.resolve('dist/bin.js'),
    '--codesys-path',process.execPath,'--codesys-profile','TEST-NO-IDE','--workspace',workspace,'--no-auto-launch','--read-only'],stderr:'pipe'});
  const client=new Client({name:'regression',version:'1.0.0'});
  try {
    await client.connect(transport);
    const list=await client.listTools();const names=list.tools.map(t=>t.name);
    expect(names).toContain('get_pou_code');expect(names).toContain('get_task_config');
    expect(names).toContain('recover_session');expect(names).not.toContain('shutdown_codesys');
    expect(names).not.toContain('write_variable');expect(names).not.toContain('eval_python');expect(names).not.toContain('set_pou_code');
    const status=await client.callTool({name:'get_codesys_status',arguments:{}});
    expect(JSON.stringify(status)).toContain('stopped');
    expect(status.structuredContent).toMatchObject({schemaVersion:'1.0',ok:true,tool:'get_codesys_status'});
    const recovery=await client.callTool({name:'recover_session',arguments:{acknowledge:true}});
    expect(recovery.isError).toBe(true);expect(recovery.structuredContent).toMatchObject({ok:false,result:{state:'unavailable'}});
    const failed=await client.callTool({name:'get_pou_code',arguments:{projectFilePath:'nonexistent.project',pouPath:'Application/P'}});
    expect(failed.isError).toBe(true);expect(JSON.stringify(failed)).toContain('not ready');
    const outside=await client.callTool({name:'get_pou_code',arguments:{projectFilePath:'../outside.project',pouPath:'Application/P'}});
    expect(outside.isError).toBe(true);expect(JSON.stringify(outside)).toContain('outside');
  } finally {await client.close();fs.rmSync(workspace,{recursive:true,force:true});}
});

it('online and Python capabilities are opt-in and full download requires an explicit flag',async()=>{
  const workspace=fs.mkdtempSync(path.join(os.tmpdir(),'inoproshop-stdio-'));
  const transport=new StdioClientTransport({command:process.execPath,args:[path.resolve('dist/bin.js'),
    '--codesys-path',process.execPath,'--codesys-profile','TEST-NO-IDE-ONLINE','--workspace',workspace,
    '--no-auto-launch','--enable-online','--enable-python'],stderr:'pipe'});
  const client=new Client({name:'regression-options',version:'1.0.0'});
  try {
    await client.connect(transport);
    const list=await client.listTools();const names=list.tools.map(t=>t.name);
    expect(names).toContain('write_variable');expect(names).toContain('download_to_device');expect(names).toContain('eval_python');
    const refused=await client.callTool({name:'download_to_device',arguments:{projectFilePath:'test.project',mode:'full'}});
    expect(refused.isError).toBe(true);expect(JSON.stringify(refused)).toContain('confirmFullDownload=true');
    const capabilities=await client.callTool({name:'get_capabilities',arguments:{}});
    const payload=JSON.parse((capabilities.content as Array<{type:string;text:string}>)[0].text);
    expect(payload.online).toBe(true);expect(payload.arbitraryPython).toBe(true);expect(payload.hardwareValidated).toBe(false);
  } finally {await client.close();fs.rmSync(workspace,{recursive:true,force:true});}
});
