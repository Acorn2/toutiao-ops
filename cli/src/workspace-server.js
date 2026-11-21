import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { promisify } from 'node:util';
import { createWorkspaceData } from './workspace-data.js';
import { failureResult } from './result.js';
import { fail } from './errors.js';

const assets = new Map([
  ['/', ['text/html; charset=utf-8', '../workspace/index.html']],
  ['/app.js', ['text/javascript; charset=utf-8', '../workspace/app.js']],
  ['/style.css', ['text/css; charset=utf-8', '../workspace/style.css']],
  ['/logo.svg', ['image/svg+xml', '../workspace/logo.svg']],
  ['/vue.js', ['text/javascript; charset=utf-8', '../node_modules/@vue/runtime-dom/dist/runtime-dom.esm-browser.prod.js']],
]);
const openBrowser = promisify(execFile);

function reply(response, status, data) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(data));
}

async function readAction(request) {
  if (request.headers['content-type'] !== 'application/json') fail('INVALID_REQUEST', '请输入 JSON 请求');
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 8192) fail('INVALID_REQUEST', '请求过长');
    chunks.push(chunk);
  }
  let body;
  try { body = JSON.parse(Buffer.concat(chunks)); } catch { fail('INVALID_REQUEST', '请求格式无效'); }
  if (!body || typeof body.account !== 'string') fail('INVALID_REQUEST', '请显式指定账号');
  return body;
}

export function createWorkspaceServer(data = createWorkspaceData()) {
  const server = createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
    const host = request.headers.host;
    const { port } = server.address();
    if (![`127.0.0.1:${port}`, `localhost:${port}`].includes(host)) return reply(response, 403, { error_code: 'ORIGIN_FORBIDDEN' });

    try {
      if (request.method === 'GET' && assets.has(request.url)) {
        const [type, path] = assets.get(request.url);
        const body = await readFile(new URL(path, import.meta.url));
        response.writeHead(200, { 'Content-Type': type });
        return response.end(body);
      }
      if (request.method === 'GET' && request.url === '/api/workspace') return reply(response, 200, data.overview());
      if (request.method === 'POST' && ['/api/sync', '/api/open-draft'].includes(request.url)) {
        if (request.headers.origin !== `http://${host}`) return reply(response, 403, { error_code: 'ORIGIN_FORBIDDEN' });
        const { account, key } = await readAction(request);
        if (request.url === '/api/sync') return reply(response, 200, await data.sync(account));
        if (typeof key !== 'string') fail('INVALID_REQUEST', '请选择一条草稿');
        return reply(response, 200, await data.openDraft(account, key));
      }
      reply(response, 404, { error_code: 'NOT_FOUND' });
    } catch (error) {
      const { error_code, message } = failureResult({}, error);
      reply(response, 400, { error_code, message });
    }
  });
  return server;
}

export async function startWorkspace({ port, open }) {
  const server = createWorkspaceServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  const url = `http://127.0.0.1:${server.address().port}`;
  process.stdout.write(`头条号工作台 ${url}\n`);
  if (open) {
    try { await openBrowser('/usr/bin/open', [url]); }
    catch { process.stderr.write(`请在浏览器打开 ${url}\n`); }
  }
}
