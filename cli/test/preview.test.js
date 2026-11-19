import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareArticle } from '../src/article-input.js';
import { buildPreviewHtml, writePreviewFile } from '../src/article-preview.js';
import { publishArticle } from '../src/publish-article.js';

const dir = mkdtempSync(join(tmpdir(), 'toutiao-preview-'));
const image = join(dir, 'image.png');
writeFileSync(image, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64'));
const article = join(dir, 'article.md');
writeFileSync(article, '# 本地预览\n\n前文 ![正文图](image.png) 后文\n\n<script>alert(1)</script>');

test('离线预览内嵌图片并限制脚本，无源稿路径，不覆盖文件', () => {
  const input = prepareArticle({ dryRun: true, contentFile: article, cover: image });
  const html = buildPreviewHtml(input);
  assert.match(html, /default-src 'none'/);
  assert.match(html, /data:image\/png;base64,/);
  assert.ok(!html.includes('<script>')); assert.ok(!html.includes('TTOPSIMG'));
  assert.ok(!html.includes(dir));
  const file = join(dir, 'preview.html');
  writePreviewFile(file, html);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.throws(() => writePreviewFile(file, 'overwrite'), { code: 'PREVIEW_WRITE_FAILED' });
  assert.equal(readFileSync(file, 'utf8'), html);
});
test('显式导出 dry-run HTML 返回新文件路径且未验证平台', async () => {
  const file = join(dir, 'cli-preview.html');
  const result = await publishArticle({ dryRun: true, contentFile: article, previewFile: file });
  assert.equal(result.status, 'validated'); assert.equal(result.verified, false);
  assert.equal(result.title, '本地预览'); assert.equal(result.preview_file, file);
  assert.equal(result.preview.title_source, 'markdown_h1');
  assert.match(readFileSync(file, 'utf8'), /前文/);
  const repeated = await publishArticle({ dryRun: true, contentFile: article, previewFile: file });
  assert.equal(repeated.error_code, 'PREVIEW_FILE_EXISTS');
});
test('图片变化或总预览超限时停止，不把变化后的文件写入 HTML', () => {
  const input = prepareArticle({ dryRun: true, contentFile: article });
  const tooLarge = { ...input, images: input.images.map(image => ({ ...image, size: 21 * 1024 * 1024 })) };
  assert.throws(() => buildPreviewHtml(tooLarge), { code: 'PREVIEW_TOO_LARGE' });
  writeFileSync(image, 'changed');
  assert.throws(() => buildPreviewHtml(input), { code: 'INPUT_CHANGED' });
});
