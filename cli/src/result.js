import { randomUUID } from 'node:crypto';
import { openSync, closeSync, writeFileSync, existsSync, lstatSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fail, errorCode, OperationError } from './errors.js';

const secretKey = /cookie|authorization|token|password|secret|private.?key|storage.?state|fingerprint/i;
export function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, secretKey.test(k) ? '[REDACTED]' : redact(v)]));
  if (typeof value !== 'string') return value;
  return value
    .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, '[REDACTED]')
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|npm_[A-Za-z0-9]+|sk-[A-Za-z0-9_-]+)/g, '[REDACTED]')
    .replace(/\b(cookie|authorization|[a-z_]*(?:token|secret|password|api_key))\s*[:=]\s*[^\n]+/gi, '$1=[REDACTED]')
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, '[REDACTED]')
    .replace(/https?:\/\/[^\s"<>]+/g, text => {
      try { const url = new URL(text); url.username = ''; url.password = ''; for (const key of url.searchParams.keys()) if (secretKey.test(key)) url.searchParams.set(key, '[REDACTED]'); return url.toString(); }
      catch { return '[URL]'; }
    });
}

export function makeResult(opts = {}, patch = {}) {
  return {
    success: false, action: opts.action || (opts.dryRun ? 'validate' : opts.draft ? 'draft_save' : 'publish'),
    account: opts.account || null, title: opts.title || null, status: 'failed', verified: false,
    article_id: null, url: null, message: '', request_id: opts.requestId || randomUUID(), ...patch,
  };
}

export function failureResult(opts, error, patch = {}) {
  return makeResult(opts, {
    error_code: errorCode(error),
    message: error instanceof OperationError ? error.message : '操作失败；请检查本地诊断和页面状态', ...patch,
  });
}

export function validateResultFile(path) {
  if (!path) return;
  if (existsSync(path)) fail('RESULT_FILE_EXISTS', '结果文件已存在；请使用新的文件名，避免覆盖内容');
  try {
    if (!lstatSync(dirname(resolve(path))).isDirectory()) throw new Error();
    // Also reject dangling symbolic links.
    try { lstatSync(path); fail('RESULT_FILE_EXISTS', '结果路径已存在'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  } catch (e) { if (e instanceof OperationError) throw e; fail('INVALID_RESULT_PATH', '结果文件父目录不存在或不可用'); }
}

export function writeResultFile(path, result) {
  if (!path) return;
  const fd = openSync(resolve(path), 'wx', 0o600);
  try { writeFileSync(fd, JSON.stringify(redact(result), null, 2) + '\n'); }
  finally { closeSync(fd); }
}
