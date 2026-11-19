import { readFileSync, openSync, closeSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { escapeHtml } from './article-input.js';
import { fail } from './errors.js';

export function buildPreviewHtml(input) {
  const assets = [...input.images, ...(input.cover ? [input.cover] : [])];
  if (assets.reduce((size, image) => size + image.size, 0) > 20 * 1024 * 1024) fail('PREVIEW_TOO_LARGE', '离线预览中的图片引用合计不能超过 20 MiB；可继续使用 JSON 本地校验');
  const encoded = new Map();
  const source = image => {
    if (!encoded.has(image.sha256)) {
      const bytes = readFileSync(image.path);
      if (createHash('sha256').update(bytes).digest('hex') !== image.sha256) fail('INPUT_CHANGED', '图片在预览校验后发生变化，停止导出');
      encoded.set(image.sha256, `data:${image.type};base64,${bytes.toString('base64')}`);
    }
    return encoded.get(image.sha256);
  };
  let html = input.html;
  for (const image of input.images) html = html.replace(image.marker, `<img src="${source(image)}" alt="${escapeHtml(image.alt)}">`);
  const cover = input.cover ? `<figure><img src="${source(input.cover)}" alt="封面预览"><figcaption>封面预览</figcaption></figure>` : '';
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(input.title)}</title>
<style>body{max-width:820px;margin:40px auto;padding:0 24px;font:17px/1.8 system-ui,sans-serif;color:#202124}img{max-width:100%;height:auto}pre{overflow:auto;white-space:pre-wrap;background:#f4f5f6;padding:16px}blockquote{border-left:3px solid #aaa;margin-left:0;padding-left:16px}table{border-collapse:collapse}td,th{border:1px solid #ccc;padding:8px}figcaption,.notice{font-size:14px;color:#666}</style>
</head><body><p class="notice">本地排版预览；平台实际样式仍需检查草稿。图片已内嵌，不访问网络。</p><h1>${escapeHtml(input.title)}</h1>${cover}<article>${html}</article></body></html>`;
}

export function writePreviewFile(path, html) {
  let fd;
  try {
    fd = openSync(resolve(path), 'wx', 0o600);
    writeFileSync(fd, html);
  } catch { fail('PREVIEW_WRITE_FAILED', '无法写入离线预览；不会覆盖现有文件，请换用新路径'); }
  finally { if (fd !== undefined) closeSync(fd); }
  return resolve(path);
}
