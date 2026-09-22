/**
 * Python script template loading and interpolation.
 * Loads .py templates from src/scripts/ and performs {PARAM} replacement.
 */

import * as fs from 'fs';
import * as path from 'path';
import { ScriptParams } from './types';

/**
 * Escape a string for safe embedding inside an IronPython 2.7 double-quoted
 * string literal. Handles backslash, double-quote, single-quote, and the
 * standard line/whitespace escapes.
 */
function pyEscape(s: string): string {
  return s
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/'/g, "\\'")
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, c => '\\x' + c.charCodeAt(0).toString(16).padStart(2, '0'));
}

export class ScriptManager {
  private scriptsDir: string;

  constructor(scriptsDir?: string) {
    this.scriptsDir = scriptsDir ?? path.join(__dirname, 'scripts');
  }

  /** Load a template file from disk. */
  loadTemplate(name: string): string {
    if (!/^[A-Za-z_][A-Za-z0-9_]*(?:\.py)?$/.test(name)) throw new Error('Invalid script template name.');
    const fileName = name.endsWith('.py') ? name : `${name}.py`;
    const filePath = path.join(this.scriptsDir, fileName);
    if (!fs.existsSync(filePath)) {
      throw new Error(`Script template not found: ${filePath}`);
    }
    return fs.readFileSync(filePath, 'utf-8');
  }

  /**
   * Replace {KEY} placeholders with Python-string-escaped values.
   *
   * Every value is escaped for safe embedding inside a Python double-quoted
   * string literal: backslashes, double/single quotes, and newline chars are
   * escaped. This eliminates injection bugs where a user-controlled identifier
   * (POU name, variable path, password) could contain a `"` that broke out
   * of the string literal in the generated IronPython source.
   *
   * For values that must be embedded outside a string (raw code blocks like
   * internal source only), use `{KEY:raw}` in the template. Never pass user
   * code through raw placeholders; set_pou_code uses ordinary escaped data.
   *
   * The replace callback form is used so a `$` in the value isn't interpreted
   * as a regex backreference token.
   */
  interpolate(template: string, params: ScriptParams): string {
    // One pass: user ST containing {UPDATE_IMPL} must stay literal.
    return template.replace(/\{([A-Z][A-Z0-9_]*)(:raw)?\}/g, (match, key, raw) => {
      if (!Object.prototype.hasOwnProperty.call(params, key)) throw new Error(`Missing script parameter: ${key}`);
      return raw ? String(params[key]) : pyEscape(String(params[key]));
    });
  }

  /** Concatenate multiple script fragments with double newlines */
  combineScripts(...scripts: string[]): string {
    return scripts.join('\n\n');
  }

  /** Load a template and interpolate parameters */
  prepareScript(name: string, params: ScriptParams): string {
    const template = this.loadTemplate(name);
    return this.source(this.interpolate(template, params));
  }

  private source(body: string): string {
    // IronPython 2.7 otherwise creates byte literals from Chinese parameters.
    return '# -*- coding: utf-8 -*-\nfrom __future__ import unicode_literals\n' + body.replace(/\r\n?/g, '\n');
  }

  /** Prepend helper scripts before the main script, then interpolate all */
  prepareScriptWithHelpers(
    name: string,
    params: ScriptParams,
    helpers: string[]
  ): string {
    const readOnly = new Set(['get_all_pou_code','get_pou_code','get_project_structure','search_code',
      'get_compile_messages','list_project_libraries','inspect_device_node','read_variable','get_application_state']);
    const read = readOnly.has(name);
    const helperContents = helpers.map((h) => this.loadTemplate(read && h === 'ensure_project_open' ? 'require_project_open' : h));
    const mainTemplate = read ? this.loadTemplate(name).replace(/\bensure_project_open\b/g, 'require_project_open') : this.loadTemplate(name);
    const combined = this.combineScripts(...helperContents, mainTemplate);
    return this.source(this.interpolate(combined, params));
  }
}
