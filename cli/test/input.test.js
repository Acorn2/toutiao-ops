import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, symlinkSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertEgoDraftInput, prepareArticle, previewArticle, MAX_IMAGE_BYTES } from '../src/article-input.js';
import { egoMediaProof, matchesEgoMedia, setEgoCover, setEgoImageCaption } from '../src/ego-article-media.js';
import { observeEgoDraftResponse, waitEgoDraftSave } from '../src/ego-draft-save.js';
import { contentSnapshot } from '../src/article-records.js';

const dir = mkdtempSync(join(tmpdir(), 'toutiao-input-'));
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
writeFileSync(join(dir, '图.png'), png);
const options = { title: '测试文章', content: '有效正文', dryRun: true };
const rejects = (opts, code) => assert.throws(() => prepareArticle({ ...options, ...opts }), { code });

test('动作必须明确且互斥', () => {
  rejects({ dryRun: false }, 'ACTION_REQUIRED');
  rejects({ draft: true }, 'ACTION_REQUIRED');
  rejects({ publish: true }, 'ACTION_REQUIRED');
  rejects({ dryRun: false, draft: true, publish: true }, 'ACTION_REQUIRED');
});
test('写操作必须指定合法账号', () => {
  rejects({ dryRun: false, draft: true }, 'ACCOUNT_REQUIRED');
  for (const account of ['../a', '/tmp/a', 'a/b', '.', '..', 'a\\b', '中文', '-a', 'Account_A', 'a'.repeat(65)]) rejects({ account }, 'INVALID_ACCOUNT');
});
test('标题和正文必须有效，不会截断标题', () => {
  for (const title of ['', 'a', 'a'.repeat(31), '测试\n文章']) rejects({ title }, 'INVALID_TITLE');
  for (const content of ['', '  ', '\0']) rejects({ content }, 'INVALID_CONTENT');
  assert.equal(prepareArticle({ ...options, title: '😀'.repeat(30) }).title, '😀'.repeat(30));
});
test('文件优先、UTF-8 编码及大小校验', () => {
  rejects({ contentFile: join(dir, 'missing.md') }, 'INVALID_CONTENT_FILE');
  writeFileSync(join(dir, 'invalid.md'), Buffer.from([0xff, 0xfe]));
  rejects({ contentFile: join(dir, 'invalid.md') }, 'INVALID_ENCODING');
  writeFileSync(join(dir, 'valid.md'), '## 文件正文');
  const input = prepareArticle({ ...options, contentFile: join(dir, 'valid.md') });
  assert.match(input.html, /<h2>文件正文<\/h2>/);
  assert.ok(input.warnings.some(w => w.includes('忽略')));
});
test('Markdown 保留层级、强调、列表、引用、代码、链接、图片顺序', () => {
  writeFileSync(join(dir, 'article.md'), '# 一级\n\n## 二级\n\n**加粗** & 特殊字符\n\n- 一\n- 二\n\n> 引用\n\n```js\nconst value = "<tag>";\n```\n\n[来源](https://example.com/source)\n\n前文 ![甲](图.png) 中文 ![乙](图.png) 后文');
  const input = prepareArticle({ ...options, contentFile: join(dir, 'article.md') });
  for (const tag of ['h1', 'h2', 'strong', 'ul', 'blockquote', 'pre', 'code', 'a']) assert.match(input.html, new RegExp(`<${tag}[ >]`));
  assert.match(input.html, /&lt;tag&gt;/);
  assert.equal(input.images.length, 2);
  assert.ok(input.html.indexOf(input.images[0].marker) < input.html.indexOf(input.images[1].marker));
  const preview = previewArticle(input);
  assert.equal(preview.unique_image_count, 1);
  assert.ok(!JSON.stringify(preview).includes(dir));
});
test('Ego 默认取首张正文图作为单图封面，允许重复配图', () => {
  const file = join(dir, 'cover-threshold.md');
  const names = ['封面一.png', '封面二.png', '封面三.png', '封面四.png'];
  for (const [i, name] of names.entries()) writeFileSync(join(dir, name), Buffer.concat([png, Buffer.from([i])]));
  const prepare = images => {
    writeFileSync(file, images.map(name => `![说明](${name})`).join('\n\n'));
    return prepareArticle({ ...options, contentFile: file });
  };
  assert.deepEqual(previewArticle(prepare(names.slice(0, 2))).ego_cover, { mode: 'single', image_positions: [1] });
  for (const count of [3, 4]) {
    const input = prepare(names.slice(0, count));
    assert.doesNotThrow(() => assertEgoDraftInput(input));
    assert.deepEqual(previewArticle(input).ego_cover, { mode: 'single', image_positions: [1] });
  }
  const repeated = prepare([names[0], names[1], names[0]]);
  assert.doesNotThrow(() => assertEgoDraftInput(repeated));
  assert.deepEqual(repeated.egoCover, [0]);
});
test('Ego 已选单图且首图一致时跳过选图，错误封面仍进入选择流程', async () => {
  const src = 'https://image-tt-private.toutiao.com/tos-fixture/image-1?x-orig-sign=old';
  const source = { src, uri: 'tos-fixture/image-1' };
  const page = { evaluate: async () => [{ checked: true }], waitForFunction: () => { throw new Error('进入选图流程'); } };
  const select = url => setEgoCover(page, [0], [source], undefined, { mode: '单图', covers: [{ ready: true, src: url }] });
  assert.equal(await select(src.replace('=old', '=renewed')), '单图');
  await assert.rejects(select(src.replace('image-1', 'image-2')), /进入选图流程/);
});
test('Ego 图文回查容许签名轮换，拒绝图注变更、不同对象和不同裁剪参数', () => {
  const input = { images: [{ caption: '原图说明' }], egoCover: [0] };
  const state = (query, caption = '原图说明', object = 'image-1') => {
    const uri = `tos-fixture/${object}`;
    const src = `https://image-tt-private.toutiao.com/${uri}?${query}`;
    return egoMediaProof({ mode: '单图', sources: [{ src, uri, caption, ready: true }], covers: [{ src, ready: true }] }, input, '单图');
  };
  const expected = state('x-orig-sign=old&crop=middle');
  assert.equal(matchesEgoMedia(state('crop=middle&x-orig-sign=new'), expected), true);
  assert.equal(matchesEgoMedia(state('x-orig-sign=new&crop=left'), expected), false);
  assert.equal(matchesEgoMedia(state('x-orig-sign=new&crop=middle', '错误图注'), expected), false);
  assert.equal(matchesEgoMedia(state('x-orig-sign=new&crop=middle', '原图说明', 'image-2'), expected), false);
});
test('Ego 封面对象改写时核对实际图像并拒绝封面换序', () => {
  const cover = (name, gray) => ({
    key: name, asset: name, variant: name, caption: null,
    visual: { ratio: 1.28, rgb: Buffer.alloc(1200, gray).toString('base64') },
  });
  const expected = { mode: '三图', images: [], covers: [cover('a', 30), cover('b', 90), cover('c', 180)] };
  const actual = { ...expected, covers: [cover('new-a', 32), cover('new-b', 92), cover('new-c', 182)] };
  assert.equal(matchesEgoMedia(actual, expected), true);
  assert.equal(matchesEgoMedia({ ...actual, covers: [actual.covers[1], actual.covers[0], actual.covers[2]] }, expected), false);
  assert.equal(matchesEgoMedia({ ...actual, covers: [cover('other', 55), ...actual.covers.slice(1)] }, expected), false);
});
test('Ego 封面证明拒绝重复封面和取错的正文图', () => {
  const image = (index, signature = 'initial') => {
    const uri = `tos-fixture/image-${index}`;
    return { src: `https://image-tt-private.toutiao.com/${uri}?x-orig-sign=${signature}`, uri, ready: true };
  };
  const sources = [1, 2, 3].map(index => ({ ...image(index), caption: String(index) }));
  const input = { images: sources, egoCover: [0, 1, 2] };
  const proof = covers => egoMediaProof({ mode: '三图', sources, covers }, input, '三图');
  assert.ok(proof([image(1), image(2), image(3)]));
  assert.ok(proof([image(1), image(4), image(3)])); // The platform can generate a new object when cropping.
  assert.equal(proof([image(1), image(3), image(3, 'renewed')]), null);
  assert.equal(proof([image(2), image(1), image(3)]), null);
});
test('Ego 匹配当前自动保存回执，忽略相同稿件的预览请求', async () => {
  const url = 'https://mp.toutiao.com/mp/agw/article/publish';
  const events = ['wrong-draft', 'old-content', 'preview-json', 'preview-form', 'save'].flatMap(requestId => {
    const body = {
      save: '0', pgc_id: requestId === 'wrong-draft' ? '1002' : '9007199254740993123',
      title: '验收标题', content: requestId === 'old-content' ? '<p>上一版</p>' : '<p>当前版</p>',
    };
    if (requestId.startsWith('preview')) body.is_app_preview = 1;
    const postData = requestId === 'preview-form' ? new URLSearchParams(body).toString() : JSON.stringify(body);
    return [
      { method: 'Network.requestWillBeSent', params: { requestId, request: { method: 'POST', url, postData } } },
      { method: 'Network.responseReceived', params: { requestId, response: { url, status: 200 } } },
    ];
  });
  let clear = true;
  const shape = text => ({ structure: [['p', [text]]], links: [], images: [] });
  const accepted = [];
  const page = {
    cdp: async (method, { requestId } = {}) => {
      if (method !== 'Network.getResponseBody') return {};
      accepted.push(requestId);
      return { body: requestId === 'preview-json' ? '{"code":7050}' : '{"code":0,"data":{"pgc_id":9007199254740993123}}' };
    },
    events: async () => { if (clear) { clear = false; return []; } return events.splice(0); },
    url: async () => 'https://mp.toutiao.com/profile_v4/graphic/publish?pgc_id=9007199254740993123',
    evaluate: async (_fn, html) => shape(html.replace(/<\/?p>/g, '')),
  };
  const saved = await waitEgoDraftSave(await observeEgoDraftResponse(page), {
    draftId: '9007199254740993123', title: '验收标题', images: [], snapshot: contentSnapshot(shape('当前版')),
  });
  assert.deepEqual(accepted, ['save']);
  assert.equal(saved.draftId, '9007199254740993123');
});
test('Ego 匹配 7050 后立即恢复，仅接受更新的成功回执', async () => {
  const observe = sequence => async (_expected, onRejected7050) => {
    onRejected7050(2);
    return { accepted: { draftId: '1001', sequence }, pendingSequences: [] };
  };
  await assert.rejects(waitEgoDraftSave(observe(1), {}), { code: 'DRAFT_SAVE_7050_UNCONFIRMED' });
  const saved = await waitEgoDraftSave(observe(3), {});
  assert.equal(saved.draftId, '1001');
});
test('7050 后只等同版本已在途的较新回执，按请求顺序判断成功', async () => {
  const url = 'https://mp.toutiao.com/mp/agw/article/publish';
  const sent = (id, content, preview = false) => ({ method: 'Network.requestWillBeSent',
    params: { requestId: id, request: { method: 'POST', url, postData: JSON.stringify({
      title: '标题', content, save: 0, pgc_id: '1001', is_app_preview: Number(preview),
    }) } } });
  const received = id => ({ method: 'Network.responseReceived', params: { requestId: id, response: { url, status: 200 } } });
  const shape = text => ({ structure: [text], links: [], images: [] });
  const expected = { title: '标题', draftId: '1001', images: [], snapshot: contentSnapshot(shape('当前')) };
  for (const hasNewer of [true, false]) {
    const batches = [[], [sent('reject', '当前'), received('reject'), sent('other', '旧版'), sent('preview', '当前', true)],
      [received('late')]];
    if (hasNewer) batches[1].push(sent('late', '当前'));
    const page = {
      events: async () => batches.shift(), url: async () => 'https://mp.toutiao.com/?pgc_id=1001',
      evaluate: async (_fn, text) => shape(text),
      cdp: async (method, { requestId }) => method === 'Network.getResponseBody'
        ? { body: JSON.stringify({ code: requestId === 'reject' ? 7050 : 0 }) } : {},
    };
    const saving = waitEgoDraftSave(await observeEgoDraftResponse(page), expected);
    if (hasNewer) assert.deepEqual(await saving, { draftId: '1001' });
    else await assert.rejects(saving, { code: 'DRAFT_SAVE_7050_UNCONFIRMED' });
    assert.equal(batches.length, hasNewer ? 0 : 1);
  }
});
test('7050 后在途请求一直未返回时，有界退出且保留拒绝原因', async () => {
  let reads = 0;
  const observe = async (_expected, reject) => {
    if (++reads === 1) reject(1);
    return { accepted: null, pendingSequences: [2] };
  };
  await assert.rejects(waitEgoDraftSave(observe, {}), { code: 'DRAFT_SAVE_7050_UNCONFIRMED' });
  assert.ok(reads > 1);
});
test('Ego 图注分别报告定位、焦点、粘贴和回读失败', async () => {
  for (const phase of ['LOCATE', 'FOCUS', 'PASTE', 'READBACK']) {
    const check = actual => { if (actual === phase) throw new Error('受控失败'); };
    const page = {
      cdp: async () => ({}),
      events: async () => [],
      evaluate: async () => true,
      waitForSelector: async () => check('LOCATE'),
      waitForFunction: async (_fn, args) => check('value' in args ? 'READBACK' : 'FOCUS'),
      keyboard: { paste: async () => check('PASTE') },
    };
    await assert.rejects(() => setEgoImageCaption(page, { caption: '图注' }, 0), { code: `IMAGE_CAPTION_${phase}_FAILED` });
  }
});
test('拒绝危险链接，原始 HTML 只显示为文本', () => {
  rejects({ content: '[执行](javascript:alert%281%29)' }, 'UNSAFE_LINK');
  const input = prepareArticle({ ...options, content: '<script>alert(1)</script>\n\n正文' });
  assert.ok(!input.html.includes('<script>'));
  assert.match(input.html, /&lt;script&gt;/);
});
test('正文图片不下载、不读取文章目录之外的文件', () => {
  for (const src of ['https://example.com/a.png', 'data:image/png;base64,abc']) rejects({ content: `![图](${src})` }, 'REMOTE_IMAGE_UNSUPPORTED');
  mkdirSync(join(dir, 'nested'));
  writeFileSync(join(dir, 'nested', 'escape.md'), '![图](../图.png)');
  rejects({ contentFile: join(dir, 'nested', 'escape.md') }, 'UNSAFE_IMAGE_PATH');
  symlinkSync(join(dir, '图.png'), join(dir, 'nested', 'link.png'));
  writeFileSync(join(dir, 'nested', 'link.md'), '![图](link.png)');
  rejects({ contentFile: join(dir, 'nested', 'link.md') }, 'UNSAFE_IMAGE_PATH');
});
test('封面类型、大小、模式与不支持格式预检', () => {
  rejects({ cover: join(dir, 'missing.png') }, 'INVALID_IMAGE');
  writeFileSync(join(dir, 'fake.png'), 'not an image');
  rejects({ cover: join(dir, 'fake.png') }, 'INVALID_IMAGE_TYPE');
  writeFileSync(join(dir, 'huge.png'), Buffer.alloc(MAX_IMAGE_BYTES + 1));
  rejects({ cover: join(dir, 'huge.png') }, 'INVALID_IMAGE');
  rejects({ coverMode: 'single' }, 'COVER_REQUIRED');
  rejects({ coverMode: 'triple' }, 'UNSUPPORTED_COVER_MODE');
  rejects({ coverMode: 'none', cover: join(dir, '图.png') }, 'INVALID_COVER_MODE');
  rejects({ format: 'html' }, 'INVALID_FORMAT');
});
test('操作签名包含内容、图片字节、封面及设置', () => {
  const first = prepareArticle(options).signature;
  assert.notEqual(first, prepareArticle({ ...options, firstPublish: true }).signature);
  assert.notEqual(first, prepareArticle({ ...options, content: '另一个正文' }).signature);
});
test('缺少显式标题时读取文件开头 H1，移除重复正文标题并保留源稿', () => {
  const source = '\n# **文件标题** &amp; 示例\n\n## 正文\n\n内容';
  const path = join(dir, 'title.md'); writeFileSync(path, source);
  const input = prepareArticle({ dryRun: true, contentFile: path });
  assert.equal(input.title, '文件标题 & 示例');
  assert.equal(input.titleSource, 'markdown_h1');
  assert.ok(!input.html.includes('<h1>')); assert.match(input.html, /<h2>正文/);
  assert.equal(readFileSync(path, 'utf8'), source);
  const override = prepareArticle({ ...options, title: '显式标题', contentFile: path });
  assert.equal(override.title, '显式标题'); assert.equal(override.titleSource, 'option');
  rejects({ title: undefined, content: '# 内联标题\n\n正文' }, 'INVALID_TITLE');
});
test('没有正文的 H1、模糊实体和预览路径冲突都在本地失败', () => {
  writeFileSync(join(dir, 'only-title.md'), '# 只有标题');
  rejects({ title: undefined, contentFile: join(dir, 'only-title.md') }, 'INVALID_CONTENT');
  writeFileSync(join(dir, 'entity-title.md'), '# &copy; 示例\n\n正文');
  rejects({ title: undefined, contentFile: join(dir, 'entity-title.md') }, 'TITLE_SOURCE_AMBIGUOUS');
  rejects({ dryRun: false, draft: true, account: 'account_a', previewFile: join(dir, 'new.html') }, 'PREVIEW_REQUIRES_DRY_RUN');
  rejects({ previewFile: join(dir, 'same.html'), resultFile: join(dir, 'same.html') }, 'OUTPUT_PATH_CONFLICT');
});
