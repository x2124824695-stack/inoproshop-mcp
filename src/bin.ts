#!/usr/bin/env node
/**
 * CLI entry point for codesys-mcp-persistent.
 */

import { program } from 'commander';
import { startMcpServer } from './server';
import { ServerConfig, ExecutionMode } from './types';

let version = '0.1.0';
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const pkg = require('../package.json');
  version = pkg.version;
} catch {
  // ignore
}

program
  .name('inoproshop-mcp')
  .description('Verified persistent MCP server for InoProShop')
  .version(version)
  .option(
    '-p, --codesys-path <path>',
    'Path to CODESYS executable',
    process.env.CODESYS_PATH || ''
  )
  .option(
    '-f, --codesys-profile <profile>',
    'CODESYS profile name',
    process.env.CODESYS_PROFILE || ''
  )
  .option(
    '-w, --workspace <dir>',
    'Workspace directory for relative project paths',
    process.cwd()
  )
  .option(
    '-m, --mode <mode>',
    'Execution mode: persistent (UI) or headless (--noUI)',
    'persistent'
  )
  .option('--no-auto-launch', 'Do not auto-launch CODESYS on startup')
  .option('--enable-online', 'Expose PLC online tools (requires target-version validation)', false)
  .option('--enable-python', 'Expose arbitrary IronPython execution (trusted development only)', false)
  .option('--read-only', 'Expose inspection and explicit project opening only', false)
  .option('--no-keep-alive', 'Save and stop watcher when MCP exits; default leaves IDE/watcher running')
  .option('--timeout <ms>', 'Default command timeout in ms', '60000')
  .option('--verbose', 'Enable verbose logging')
  .option('--debug', 'Enable debug logging (more verbose)')
  .option('--detect', 'Detect installed CODESYS versions and exit')
  .parse(process.argv);

const opts = program.opts();

// Handle --detect flag
if (opts.detect) {
  import('fs').then((fs) => {
    import('path').then((pathMod) => {
      const dirs = [
        'C:\\Program Files',
        'C:\\Program Files (x86)',
      ];
      process.stderr.write('Scanning for CODESYS installations...\n\n');
      let found = 0;
      for (const base of dirs) {
        try {
          const entries = fs.readdirSync(base);
          for (const entry of entries) {
            if (entry.toLowerCase().includes('codesys')) {
              const commonExe = pathMod.join(base, entry, 'CODESYS', 'Common', 'CODESYS.exe');
              const exists = fs.existsSync(commonExe);
              process.stderr.write(`  ${exists ? '[OK]' : '[--]'} ${pathMod.join(base, entry)}\n`);
              if (exists) {
                process.stderr.write(`        Exe: ${commonExe}\n`);
                found++;
              }
            }
          }
        } catch {
          // dir doesn't exist
        }
      }
      process.stderr.write(`\nFound ${found} CODESYS installation(s).\n`);
      process.exit(0);
    });
  });
} else {
  if (!opts.codesysPath || !opts.codesysProfile) program.error('--codesys-path and --codesys-profile are required; use the actual installed InoProShop profile.');
  if (!['persistent','headless'].includes(opts.mode)) program.error('--mode must be persistent or headless.');
  if (!Number.isInteger(Number(opts.timeout)) || Number(opts.timeout) < 1000) program.error('--timeout must be an integer >= 1000 ms.');
  if (opts.mode === 'headless' && opts.enableOnline) program.error('Online tools require persistent mode.');
  // Build server config
  const config: ServerConfig = {
    codesysPath: opts.codesysPath.trim(),
    profileName: opts.codesysProfile.trim(),
    workspaceDir: opts.workspace.trim(),
    autoLaunch: opts.autoLaunch !== false,
    keepAlive: opts.keepAlive !== false,
    enableOnline: opts.enableOnline,
    enablePython: opts.enablePython,
    readOnly: opts.readOnly,
    timeoutMs: parseInt(opts.timeout, 10) || 60000,
    verbose: opts.verbose || false,
    debug: opts.debug || false,
    mode: (opts.mode === 'headless' ? 'headless' : 'persistent') as ExecutionMode,
  };

  process.stderr.write(`Starting CODESYS MCP Server v${version}\n`);
  process.stderr.write(`  CODESYS Path: ${config.codesysPath}\n`);
  process.stderr.write(`  Profile: ${config.profileName}\n`);
  process.stderr.write(`  Mode: ${config.mode}\n`);
  process.stderr.write(`  Auto-launch: ${config.autoLaunch}\n`);

  startMcpServer(config).catch((err) => {
    process.stderr.write(`FATAL: ${err.message}\n`);
    process.exit(1);
  });
}
