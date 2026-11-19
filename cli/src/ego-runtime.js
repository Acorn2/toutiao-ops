import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { BASE_DIR, assertLocalPath } from './account-store.js';
import { withAccountLock } from './account-lock.js';
import { OperationError } from './errors.js';

export function withEgoLock(run) {
  // Native paste uses the macOS clipboard, including across distinct browser profiles.
  assertLocalPath(BASE_DIR);
  return withAccountLock('clipboard', 'ego_browser', run, join(BASE_DIR, 'ego'));
}

export function runEgo(method, payload) {
  const moduleUrl = new URL('./ego-worker.js', import.meta.url).href;
  const marker = `toutiao-result-${randomUUID()}:`;
  const script = `
    const worker = await import(${JSON.stringify(moduleUrl)});
    const result = await worker[${JSON.stringify(method)}]({ taskSpace, profiles }, ${JSON.stringify(payload)});
    console.log(${JSON.stringify(marker)} + JSON.stringify(result));
  `;
  return new Promise((resolve, reject) => {
    const child = spawn('ego-browser', ['nodejs'], { stdio: ['pipe', 'pipe', 'pipe'] });
    const bufferLimit = method === 'listPublications' ? 2 * 1024 * 1024 : 128 * 1024;
    let output = '';
    let diagnostics = '';
    child.stdin.on('error', () => {}); // Missing executable or early SDK termination is reported below.
    child.stdout.setEncoding('utf8').on('data', chunk => { output = (output + chunk).slice(-bufferLimit); });
    // Ego Lite can write embedded Node console output to stderr.
    child.stderr.setEncoding('utf8').on('data', chunk => { diagnostics = (diagnostics + chunk).slice(-bufferLimit); });
    child.once('error', error => reject(new OperationError(error.code === 'ENOENT' ? 'EGO_NOT_INSTALLED' : 'EGO_RUNTIME_FAILED',
      error.code === 'ENOENT' ? '找不到 ego-browser，请先安装并打开 Ego Lite' : '无法启动 ego-browser 本地运行时')));
    child.once('close', code => {
      const line = [...output.split('\n'), ...diagnostics.split('\n')].find(text => text.startsWith(marker));
      if (code === 0 && line) {
        try { resolve(JSON.parse(line.slice(marker.length))); return; } catch { /* Report invalid transport below. */ }
      }
      reject(new OperationError('EGO_RUNTIME_FAILED', 'ego-browser 未返回可核对的结果，请检查 Ego Lite 会话'));
    });
    child.stdin.end(script);
  });
}
