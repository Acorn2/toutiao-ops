import { readFileSync, statSync, realpathSync } from 'node:fs';
import { resolve, dirname, basename, extname, relative, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { TextDecoder } from 'node:util';
import { Marked } from 'marked';
import { validateAccount } from './account-store.js';
import { fail, OperationError } from './errors.js';
import { validateResultFile } from './result.js';

export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_CONTENT_BYTES = 2 * 1024 * 1024;
export const escapeHtml = (text = '') => String(text).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const hash = value => createHash('sha256').update(value).digest('hex');
const TRIPLE_COVER_COUNT = 3;

function localFile(path, limit, code) {
  try {
    const file = realpathSync(path);
    const stat = statSync(file);
    if (!stat.isFile() || stat.size === 0 || stat.size > limit) fail(code, '输入文件为空、超限或不是普通文件');
    const bytes = readFileSync(file);
    if (bytes.length > limit) fail(code, '输入文件超限');
    return { file, bytes };
  } catch (error) {
    if (error.code === code) throw error;
    fail(code, '输入文件不存在、不可读或不符合限制');
  }
}

export function validateImage(path) {
  const { file, bytes } = localFile(path, MAX_IMAGE_BYTES, 'INVALID_IMAGE');
  const extension = extname(file).toLowerCase();
  const png = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const jpeg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  const webp = bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
  if (!((png && extension === '.png') || (jpeg && ['.jpg', '.jpeg'].includes(extension)) || (webp && extension === '.webp'))) {
    fail('INVALID_IMAGE_TYPE', '图片仅支持扩展名和文件头一致的 PNG、JPEG、WebP');
  }
  return { path: file, size: bytes.length, sha256: hash(bytes), type: png ? 'image/png' : jpeg ? 'image/jpeg' : 'image/webp' };
}

function safeLink(href) {
  let url;
  try { url = new URL(href); } catch { fail('UNSAFE_LINK', '正文链接必须是完整的 http、https 或 mailto URL'); }
  if (!['http:', 'https:', 'mailto:'].includes(url.protocol) || url.username || url.password) fail('UNSAFE_LINK', '正文包含不安全的链接协议或凭据');
  return href;
}

function headingTitle(tokens) {
  const read = items => items.map(token => token.tokens ? read(token.tokens) : token.text || '').join('');
  const text = read(tokens);
  const entities = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  return text.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (source, entity) => {
    if (entity[0] !== '#') return entities[entity.toLowerCase()] || source;
    const point = entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
    return point > 0 && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff) ? String.fromCodePoint(point) : source;
  });
}

export function renderTextParagraphs(paragraphs) {
  return paragraphs.map(paragraph => `<p>${escapeHtml(paragraph).replace(/\n/g, '<br>')}</p>`).join('\n');
}

export function assertEgoDraftInput(input) {
  if (input.settings.firstPublish || input.settings.collection || input.settings.declaration) {
    fail('EGO_ARTICLE_OPTIONS_UNSUPPORTED', 'Ego 存稿暂不支持首发、合集或声明选项');
  }
  if (input.cover && input.egoCover.length !== 1) {
    fail('EGO_COVER_NOT_IN_BODY', 'Ego 的指定封面需与正文中的一张图片是同一文件内容');
  }
  if (!input.cover && input.images.length >= TRIPLE_COVER_COUNT && input.egoCover.length && input.egoCover.length !== TRIPLE_COVER_COUNT) {
    fail('EGO_TRIPLE_COVER_NEEDS_IMAGES', '三处及以上正文配图默认使用三图封面，需要至少三张不同的图片');
  }
}

export function prepareArticle(opts) {
  validateResultFile(opts.resultFile);
  if (opts.previewFile) {
    if (!opts.dryRun) fail('PREVIEW_REQUIRES_DRY_RUN', '--preview-file 仅用于 --dry-run 离线预览');
    try { validateResultFile(opts.previewFile); }
    catch (error) {
      if (error instanceof OperationError) fail(error.code.replace('RESULT', 'PREVIEW'), error.message.replaceAll('结果', '预览'));
      throw error;
    }
    if (opts.resultFile && resolve(opts.previewFile) === resolve(opts.resultFile)) fail('OUTPUT_PATH_CONFLICT', 'HTML 预览和 JSON 结果不能使用同一个路径');
  }
  if (opts.account !== undefined) validateAccount(opts.account);
  const modes = [opts.dryRun, opts.draft, opts.publish || opts.confirmPublish].filter(Boolean).length;
  if (modes !== 1) fail('ACTION_REQUIRED', '必须且只能选择 --dry-run、--draft 或 --publish（亦可 --confirm-publish）');
  if (!opts.dryRun && !opts.account) fail('ACCOUNT_REQUIRED', '平台写操作必须显式指定 --account');
  let title = opts.title?.trim();
  let titleSource = 'option';
  if (opts.format && !['markdown', 'text'].includes(opts.format)) fail('INVALID_FORMAT', 'V1 支持 markdown 或兼容 text 格式');
  if (opts.coverMode && !['single', 'none'].includes(opts.coverMode)) fail('UNSUPPORTED_COVER_MODE', 'V1 仅支持 single 或 none 封面模式');
  if (opts.coverMode === 'none' && opts.cover) fail('INVALID_COVER_MODE', 'none 模式不能同时指定封面');
  if (opts.coverMode === 'single' && !opts.cover) fail('COVER_REQUIRED', 'single 模式必须提供 --cover');
  if (opts.weitoutiao === true) fail('UNSUPPORTED_SYNC', 'V1 只支持长文章，请在头条后台单独处理微头条');
  const warnings = ['标题按保守的 2–30 字符预检，提交前还会校验页面限制', '平台可能降级代码块、表格及部分标题样式，请先检查草稿排版'];
  let content = opts.content || '';
  let baseDir = realpathSync(process.cwd());
  let sourcePath = null;
  if (opts.contentFile) {
    const { file, bytes } = localFile(opts.contentFile, MAX_CONTENT_BYTES, 'INVALID_CONTENT_FILE');
    try { content = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch { fail('INVALID_ENCODING', 'Markdown 文件必须是有效 UTF-8 编码'); }
    baseDir = dirname(file);
    sourcePath = file;
    if (opts.content) warnings.push('已按 --content-file 优先，忽略 --content');
  }
  if (Buffer.byteLength(content) > MAX_CONTENT_BYTES || content.includes('\0')) fail('INVALID_CONTENT', '正文包含 NUL 或超过 2 MiB');
  if (opts.title === undefined && sourcePath && opts.format !== 'text') {
    const tokens = new Marked({ gfm: true }).lexer(content);
    const index = tokens.findIndex(token => token.type !== 'space');
    const heading = tokens[index];
    if (heading?.type === 'heading' && heading.depth === 1) {
      title = headingTitle(heading.tokens).trim();
      if (/&[A-Za-z]+;/.test(title)) fail('TITLE_SOURCE_AMBIGUOUS', '一级标题含未支持的实体，请显式提供 --title');
      content = content.slice(tokens.slice(0, index).reduce((length, token) => length + token.raw.length, 0) + heading.raw.length);
      titleSource = 'markdown_h1';
    }
  }
  if (!title || [...title].length < 2 || [...title].length > 30 || /[\r\n\x00-\x1f]/.test(title)) fail('INVALID_TITLE', '请提供 2–30 字符单行 --title，或在 Markdown 文件开头写一级标题；不会截断');
  if (!content.trim()) fail('INVALID_CONTENT', '正文为空；从文件提取标题后仍须保留正文');
  const images = [];
  const textParagraphs = opts.format === 'text' ? content.split(/\n\s*\n/) : null;
  let html;
  if (textParagraphs) {
    html = renderTextParagraphs(textParagraphs);
  } else {
    const markerPrefix = `TTOPSIMG${hash(content).slice(0, 16)}`;
    const parser = new Marked({ gfm: true, breaks: true, renderer: {
      html({ text }) { warnings.push('原始 HTML 已转为纯文本，避免注入编辑器'); return escapeHtml(text); },
      image({ href, text }) {
        if (/^[a-z][a-z\d+.-]*:|^\/\//i.test(href)) fail('REMOTE_IMAGE_UNSUPPORTED', '正文图片必须是文章目录内的本地图片，不下载远程或 data URL');
        let decoded;
        try { decoded = decodeURIComponent(href); } catch { fail('INVALID_IMAGE_PATH', '图片路径编码无效'); }
        const image = validateImage(resolve(baseDir, decoded));
        const rel = relative(baseDir, image.path);
        if (isAbsolute(rel) || rel === '..' || rel.startsWith('../')) fail('UNSAFE_IMAGE_PATH', '正文图片必须位于 Markdown 所在目录或其子目录，不能通过链接逃逸');
        if (images.length >= 100) fail('TOO_MANY_IMAGES', '正文最多支持 100 处图片');
        const marker = `${markerPrefix}X${images.length}END`;
        const description = (text || '').replace(/\s+/gu, ' ').trim() || basename(image.path, extname(image.path));
        images.push({ ...image, alt: text || '', caption: [...description].slice(0, 50).join(''), marker });
        return `<span>${marker}</span>`;
      },
      link({ href, title: linkTitle, tokens }) {
        return `<a href="${escapeHtml(safeLink(href))}"${linkTitle ? ` title="${escapeHtml(linkTitle)}"` : ''}>${this.parser.parseInline(tokens)}</a>`;
      },
    } });
    html = parser.parse(content);
  }
  const cover = opts.cover ? validateImage(resolve(opts.cover)) : null;
  const coverMode = opts.coverMode || (cover ? 'single' : 'none');
  const distinct = [...new Set(images.map(image => image.sha256))].map(sha => images.findIndex(image => image.sha256 === sha));
  const egoCover = opts.coverMode === 'none' ? [] : cover ? distinct.filter(i => images[i].sha256 === cover.sha256)
    : distinct.slice(0, images.length >= TRIPLE_COVER_COUNT ? TRIPLE_COVER_COUNT : 1);
  const settings = { coverMode, firstPublish: !!opts.firstPublish, collection: opts.collection || null, declaration: opts.declaration || null };
  const egoImages = opts.draft && opts.browser !== 'playwright' && images.length
    ? { captions: images.map(i => i.caption), cover: egoCover } : undefined;
  const signature = hash(JSON.stringify({ title, html, images: images.map(i => i.sha256), cover: cover?.sha256, settings, egoImages }));
  return { title, titleSource, content, textParagraphs, html, images, cover, coverMode, egoCover, sourcePath, signature, settings, warnings: [...new Set(warnings)] };
}

export function previewArticle(input) {
  let html = input.html;
  for (const image of input.images) html = html.replace(image.marker, `[本地图片 ${escapeHtml(image.alt || '未命名')} / ${image.sha256.slice(0, 12)}]`);
  return {
    html, title_source: input.titleSource, image_count: input.images.length, unique_image_count: new Set(input.images.map(i => i.sha256)).size,
    images: input.images.map(({ alt, caption, size, type, sha256 }) => ({ alt, caption, size, type, sha256 })),
    cover: input.cover ? { size: input.cover.size, type: input.cover.type, sha256: input.cover.sha256 } : null,
    ego_cover: { mode: input.egoCover.length > 1 ? 'triple' : input.egoCover.length ? 'single' : 'none',
      image_positions: input.egoCover.map(i => i + 1) },
    warnings: input.warnings,
  };
}
