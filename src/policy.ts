import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { SerialQueue } from './serial';
import {normalizeToolResponse} from './results';
import { ServerConfig } from './types';

const ONLINE = new Set(['connect_to_device','disconnect_from_device','download_to_device','set_credentials',
  'set_simulation_mode','get_application_state','read_variable','write_variable','force_variable',
  'unforce_variables','get_forced_variables','start_stop_application','monitor_variables']);
const READ = new Set(['get_codesys_status','get_command_status','get_project_structure','get_pou_code',
  'get_all_pou_code','search_code','find_references','get_compile_messages','get_device_params',
  'get_task_config','list_device_repository','inspect_device_node','list_project_libraries',
  'list_project_templates','get_application_state','read_variable','get_forced_variables','get_capabilities']);
const CONTROL = new Set(['launch_codesys','shutdown_codesys','recover_session']);

/** Resolve through existing ancestors so junctions/symlinks cannot escape roots. */
export function workspacePath(input: string, workspace: string): string {
  if (!input || input.includes('\0')) throw new Error('Invalid empty or NUL path.');
  const root = fs.realpathSync(workspace);
  let candidate = path.resolve(root, input);
  const suffix: string[] = [];
  while (!fs.existsSync(candidate)) {
    const parent = path.dirname(candidate);
    if (parent === candidate) throw new Error('Cannot resolve path.');
    suffix.unshift(path.basename(candidate));
    candidate = parent;
  }
  candidate = path.join(fs.realpathSync(candidate), ...suffix);
  const relative = path.relative(root, candidate);
  if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
    throw new Error('Path is outside the configured workspace.');
  }
  return candidate;
}

export function toolAllowed(name: string, config: ServerConfig): boolean {
  if (ONLINE.has(name) && !config.enableOnline) return false;
  if (name === 'eval_python' && (!config.enablePython || config.readOnly)) return false;
  return !config.readOnly || READ.has(name) || name === 'launch_codesys' || name === 'open_project' || name === 'recover_session';
}

/** All tool operations share one queue, including backup and lifecycle calls. */
export function guardedTools(server: any, config: ServerConfig, queue: SerialQueue) {
  const names: string[] = [];
  const stateDir = path.join(config.workspaceDir, '.inoproshop-mcp');
  return {
    names,
    tool(name: string, description: string, ...rest: any[]) {
      if (!toolAllowed(name, config)) return;
      names.push(name);
      const handler = rest.pop();
      const schema = rest[0] || {};
      const read = READ.has(name);
      const annotations = {readOnlyHint: read, destructiveHint: !read && name !== 'recover_session', idempotentHint: read || name === 'recover_session', openWorldHint: ONLINE.has(name) || name === 'eval_python'};
      server.tool(name, description, schema, annotations, async (args: any, extra: any) => queue.run(async () => {
        const requestId = randomUUID();
        let backup: string | undefined;
        try {
          const checked = {...args};
          for (const key of ['projectFilePath','filePath','archivePath','outputPath','templatePath','extraTemplateDir']) {
            if (typeof checked[key] === 'string' && checked[key]) checked[key] = workspacePath(checked[key], config.workspaceDir);
          }
          // Disk snapshot before mutations. Unsaved UI content is handled by
          // object-level rollback for set_pou_code; this is not a UI snapshot.
          const project = checked.projectFilePath;
          if (!read && !CONTROL.has(name) && name !== 'eval_python' && project && fs.existsSync(project)) {
            const backupDir = path.join(stateDir, 'backups');
            fs.mkdirSync(backupDir, {recursive: true});
            backup = path.join(backupDir, `${Date.now()}-${requestId}-${path.basename(project)}`);
            fs.copyFileSync(project, backup, fs.constants.COPYFILE_EXCL);
          }
          const result = normalizeToolResponse(await handler(checked, extra), name, requestId);
          audit(name, requestId, !result?.isError, backup);
          if (backup && result?.content) result.content.push({type: 'text', text: `Pre-operation disk backup: ${backup}`});
          return result;
        } catch (e) {
          audit(name, requestId, false, backup);
          return normalizeToolResponse({content: [{type: 'text', text: `Operation failed: ${e instanceof Error ? e.message : String(e)}${backup ? '\nDisk backup: '+backup : ''}`}], isError: true}, name, requestId);
        }
      }));
    },
  };
  function audit(tool: string, requestId: string, success: boolean, backup?: string) {
    try {
      fs.mkdirSync(stateDir, {recursive: true});
      // Never log arguments, code, credentials, or result payloads. Audit
      // failure must not turn a read-only status request into a tool failure.
      fs.appendFileSync(path.join(stateDir, 'audit.jsonl'), JSON.stringify({time: new Date().toISOString(), tool, requestId, success, backup})+'\n', 'utf8');
    } catch { /* best-effort local audit; operation result remains truthful */ }
  }
}
