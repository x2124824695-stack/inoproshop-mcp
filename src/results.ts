export function scriptSucceeded(result: {success: boolean; output: string}): boolean {
  return result.success && /^SCRIPT_SUCCESS(?:\s*:.*)?\s*$/m.test(result.output)
    && !/^SCRIPT_ERROR(?:\s*:.*)?\s*$/m.test(result.output);
}

export type CompileMessage = {severity: string; text: string; object?: string; line?: number};
export function compileResponse(output: string, transportSuccess: boolean) {
  const start = '### COMPILE_MESSAGES_START ###';
  const end = '### COMPILE_MESSAGES_END ###';
  const a = output.indexOf(start), b = output.lastIndexOf(end);
  let messages: CompileMessage[];
  try {
    if (!transportSuccess || a < 0 || b <= a) throw new Error('Compile result is incomplete; success is unknown.');
    const parsed: unknown = JSON.parse(output.slice(a + start.length, b).trim());
    if (!Array.isArray(parsed) || !parsed.every(m => m && typeof m.text === 'string'
      && ['fatal', 'error', 'warning', 'info', 'text'].includes(m.severity))) {
      throw new Error('Invalid compiler message schema.');
    }
    messages = parsed;
  } catch (e) {
    return {content: [{type: 'text' as const, text: `Compiler verification failed: ${String(e)}\n${output}`}], isError: true};
  }
  const errors = messages.filter(m => m.severity === 'error' || m.severity === 'fatal');
  const warnings = messages.filter(m => m.severity === 'warning');
  return {
    content: [{type: 'text' as const, text: `${errors.length} error(s), ${warnings.length} warning(s).\n`
      + messages.map(m => `${m.severity.toUpperCase()}: ${m.text}${m.object ? ` [${m.object}${m.line != null ? ':' + m.line : ''}]` : ''}`).join('\n')}],
    structuredContent: {verified: true, errors: errors.length, warnings: warnings.length, messages},
    isError: errors.length > 0,
  };
}
/** Add a stable envelope while retaining existing text and structured fields. */
export function normalizeToolResponse(response: any, tool: string, requestId: string) {
  if (!response || !Array.isArray(response.content)) throw new Error('Invalid tool response.');
  const ok = response.isError !== true;
  const text = response.content.filter((c: any) => c.type === 'text').map((c: any) => c.text).join('\n');
  const existing = response.structuredContent;
  let result: unknown = existing?.result ?? existing;
  if (result === undefined) {
    try { result = JSON.parse(text); }
    catch { result = {message: text}; }
  }
  return {...response, isError: !ok, structuredContent: {
    ...existing, schemaVersion: '1.0', ok, tool, requestId, result,
    ...(!ok ? {error: {message: text}} : {}),
  }};
}

export function searchCoverage(data: unknown): string {
  const value = data as any;
  if (!value || !Array.isArray(value.hits) || !Number.isInteger(value.count) || value.count !== value.hits.length
      || typeof value.truncated !== 'boolean' || !value.hits.every((h:any) => h && typeof h.path === 'string'
        && typeof h.text === 'string' && typeof h.section === 'string' && Number.isInteger(h.line) && h.line > 0
        && Number.isInteger(h.col) && h.col > 0)) throw new Error('Invalid search result schema.');
  if (value.complete === false) return '\nSearch coverage is incomplete. Inspect result.read_errors, skipped_graphical and truncated; absence of a hit is not proof of absence.';
  return '';
}
