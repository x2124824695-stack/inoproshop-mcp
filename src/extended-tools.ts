import {z} from 'zod';
import {ScriptManager} from './script-manager';
import {ScriptExecutor, ServerConfig} from './types';
import {workspacePath} from './policy';
import {parseResultJson} from './result-parser';
import {scriptSucceeded} from './results';

export function registerExtendedTools(s:any, manager:ScriptManager, executor:ScriptExecutor, config:ServerConfig) {
  const project = {projectFilePath:z.string().min(1)};
  const object = {...project, objectPath:z.string().min(1)};
  async function run(action:string,args:any,mutates=false) {
    const script=manager.prepareScriptWithHelpers('extended',{
      PROJECT_FILE_PATH:workspacePath(args.projectFilePath,config.workspaceDir),
      ACTION:action, ARGS_JSON:JSON.stringify(args),
    },['_text_utils',mutates?'ensure_project_open':'require_project_open','find_object_by_path']);
    const result=await executor.executeScript(script);
    const parsed=parseResultJson(result.output);
    if(!scriptSucceeded(result)||!parsed.ok) return {content:[{type:'text',text:result.output+'\n'+result.error}],isError:true};
    return {content:[{type:'text',text:JSON.stringify(parsed.data,null,2)}], structuredContent:{result:parsed.data},isError:false};
  }
  s.tool('get_project_structure','Read the current project object tree with explicit depth and node limits.',
    {...project,maxDepth:z.number().int().min(1).max(30).default(8),maxNodes:z.number().int().min(1).max(5000).default(1000)},
    (a:any)=>run('structure',a));
  s.tool('get_pou_code','Read one exact POU/Method/Property path and its SHA-256 for expectedHash on set_pou_code.',
    {...project,pouPath:z.string().min(1)},(a:any)=>run('code',a));
  s.tool('move_object','Move a user object to an exact parent; refuses system nodes, name collisions and moving into its descendants.',
    {...object,newParentPath:z.string().min(1)},(a:any)=>run('move',a,true));
  s.tool('get_device_params','Read descriptor parameters for a device; fails explicitly when the target exposes no supported parameter_set.',
    {...project,devicePath:z.string().min(1)},(a:any)=>run('params',a));
  s.tool('get_task_config','Read tasks, native interval values AND units, priorities and POU calls. No assumed microsecond conversion.',
    {...project,applicationPath:z.string().default('Application')},(a:any)=>run('tasks',a));
  const task={...project,applicationPath:z.string().default('Application'),taskName:z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
    interval:z.string().regex(/^\d+(?:\.\d+)?$/).optional().describe('Native numeric interval; supply intervalUnit explicitly.'),
    intervalUnit:z.enum(['us','ms','s']).optional(),priority:z.number().int().min(0).max(31).optional()};
  s.tool('create_task','Create a cyclic task using the target task API. Read back all configured values; rolls back creation on failure.',task,(a:any)=>run('create_task',a,true));
  s.tool('set_task_config','Change interval and unit together, and/or priority. Read back values; restore original fields on failure.',task,(a:any)=>run('set_task',a,true));
}
