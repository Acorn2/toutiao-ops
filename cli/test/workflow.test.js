import test from 'node:test';
import assert from 'node:assert/strict';
import { executeArticle } from '../src/article-workflow.js';
import { classifyStatus, matchesSnapshot, digest, mediaKey } from '../src/article-records.js';
import { OperationError } from '../src/errors.js';

function fixture({ entry = null, queries = [], submitError, identityError, prepareError } = {}) {
  const calls = [];
  let stored = entry;
  const store = { read: () => stored, write: value => { stored = structuredClone(value); }, get current() { return stored; } };
  const driver = {
    listVerified: true,
    assertIdentity: async () => { calls.push('identity'); if (identityError) throw identityError; },
    findRecord: async () => { calls.push('query'); return queries.shift() || null; },
    prepare: async () => { calls.push('prepare'); if (prepareError) throw prepareError; return { schema_version: 2, contentHash: digest('正文'), linksHash: digest('[]'), images: [] }; },
    checkReady: async () => { calls.push('ready'); },
    submit: async () => { calls.push('submit'); if (submitError) throw submitError; },
    diagnose: async stage => ({ stage }),
  };
  return { store, driver, calls };
}
const input = { title: '测试文章' };
const opts = { account: 'account_a', draft: true, requestId: 'fixture-request' };
const saved = { id: '1001', url: 'https://mp.toutiao.com/profile_v4/graphic/publish?id=1001', contentMatches: true, status: 'draft_saved' };

test('无持久化记录绝不返回草稿成功', async () => {
  const f = fixture();
  const result = await executeArticle(opts, input, f.driver, f.store);
  assert.equal(result.status, 'unverified'); assert.equal(result.success, false); assert.equal(result.verified, false);
  assert.deepEqual(f.calls, ['identity', 'query', 'prepare', 'identity', 'ready', 'submit', 'identity', 'query']);
});
test('持久化 ID 和完整正文匹配后才能确认草稿', async () => {
  const f = fixture({ queries: [null, saved] });
  const result = await executeArticle(opts, input, f.driver, f.store);
  assert.equal(result.status, 'draft_saved'); assert.equal(result.success, true); assert.equal(result.article_id, '1001');
  assert.equal(f.store.current.state, 'verified');
});
test('缺少正文、ID 或 URL 的结果均不能算成功', async () => {
  for (const record of [{ ...saved, contentMatches: false }, { ...saved, id: null }, { ...saved, url: null }]) {
    const f = fixture({ queries: [null, record] });
    assert.equal((await executeArticle(opts, input, f.driver, f.store)).success, false);
  }
});
test('进入审核不会标记为公开发布', async () => {
  const f = fixture({ queries: [null, { ...saved, status: 'submitted_for_review' }] });
  const result = await executeArticle({ ...opts, draft: false, publish: true }, input, f.driver, f.store);
  assert.equal(result.status, 'submitted_for_review'); assert.equal(result.success, true);
});
test('明确公开状态才返回 published', async () => {
  const f = fixture({ queries: [null, { ...saved, status: 'published' }] });
  assert.equal((await executeArticle({ ...opts, draft: false, publish: true }, input, f.driver, f.store)).status, 'published');
});
test('超时后先回查，不第二次提交', async () => {
  const f = fixture({ queries: [null, saved], submitError: new OperationError('SUBMISSION_UNCONFIRMED', '未确认') });
  assert.equal((await executeArticle(opts, input, f.driver, f.store)).success, true);
  assert.equal(f.calls.filter(c => c === 'submit').length, 1);
});
test('重复运行未知操作只查询，绝不编辑或重复创建', async () => {
  const f = fixture({ entry: { state: 'unverified' } });
  assert.equal((await executeArticle(opts, input, f.driver, f.store)).status, 'unverified');
  assert.deepEqual(f.calls, ['identity', 'query']);
});
test('队列恢复只回查，即使缺少底层操作记录也不填写编辑器', async () => {
  const f = fixture();
  const result = await executeArticle({ ...opts, reconcileOnly: true }, input, f.driver, f.store);
  assert.equal(result.status, 'unverified');
  assert.equal(f.store.current, null);
  assert.deepEqual(f.calls, ['identity', 'query']);
});
test('重复运行已确认记录仍回查平台，不仅信任本地缓存', async () => {
  const f = fixture({ entry: { state: 'verified' }, queries: [saved] });
  assert.equal((await executeArticle(opts, input, f.driver, f.store)).success, true);
  assert.deepEqual(f.calls, ['identity', 'query']);
});
test('回查同标题同正文的另一条记录时不替换原草稿 ID', async () => {
  const f = fixture({ entry: { state: 'verified', article_id: '1002' }, queries: [saved] });
  const result = await executeArticle(opts, input, f.driver, f.store);
  assert.equal(result.verified, false);
  assert.equal(f.store.current.article_id, '1002');
  assert.deepEqual(f.calls, ['identity', 'query']);
});
test('连续三次回查保留正文摘要和首次操作元信息', async () => {
  const manifest = { schema_version: 2, contentHash: digest('正文'), linksHash: digest('[]'), images: [] };
  const f = fixture({ entry: { state: 'verified', manifest, request_id: 'original', started_at: '2026-11-17T00:00:00Z' } });
  f.driver.findRecord = async (_input, entry) => ({ ...saved, contentMatches: !!entry?.manifest });
  for (let i = 0; i < 3; i++) {
    assert.equal((await executeArticle(opts, input, f.driver, f.store)).status, 'draft_saved');
    assert.deepEqual(f.store.current.manifest, manifest);
    assert.equal(f.store.current.request_id, 'original');
  }
});
test('普通回查不确定也提供诊断并保存错误阶段', async () => {
  const f = fixture();
  const result = await executeArticle(opts, input, f.driver, f.store);
  assert.equal(result.diagnostic?.stage, 'verify');
  assert.equal(f.store.current.error_code, 'PERSISTENCE_UNVERIFIED');
  assert.equal(f.store.current.stage, 'verify');
  assert.equal(f.store.current.diagnostic.stage, 'verify');
});
test('图片内容参数不会被归并，媒体摘要不保留原始 URL', () => {
  assert.notEqual(mediaKey('https://cdn.example.com/image?id=111'), mediaKey('https://cdn.example.com/image?id=222'));
  assert.ok(!mediaKey('https://cdn.example.com/image?token=private').includes('private'));
});
test('同标题歧义或列表未确认时停止创建', async () => {
  for (const ambiguous of [true, false]) {
    const f = fixture({ queries: ambiguous ? [{ ambiguous: true }] : [] });
    f.driver.listVerified = ambiguous;
    const result = await executeArticle(opts, input, f.driver, f.store);
    assert.equal(result.success, false);
    assert.ok(!f.calls.includes('prepare'));
  }
});
test('账号不一致时不访问编辑器或提交', async () => {
  const f = fixture({ identityError: new OperationError('ACCOUNT_MISMATCH', '账号不一致') });
  assert.equal((await executeArticle(opts, input, f.driver, f.store)).error_code, 'ACCOUNT_MISMATCH');
  assert.deepEqual(f.calls, ['identity']);
});
test('上传失败或浏览器关闭后不发布，保留不确定状态', async () => {
  for (const error of [new OperationError('IMAGE_UPLOAD_FAILED', '上传失败'), new Error('Target page closed')]) {
    const f = fixture({ prepareError: error });
    const result = await executeArticle(opts, input, f.driver, f.store);
    assert.equal(result.status, 'unverified'); assert.ok(!f.calls.includes('submit'));
  }
});
test('本地记录写失败也不能把可能提交的动作当作可重试失败', async () => {
  const f = fixture({ submitError: new Error('closed') });
  let writes = 0;
  f.store.write = () => { if (++writes >= 4) throw new Error('disk full'); };
  assert.equal((await executeArticle(opts, input, f.driver, f.store)).status, 'unverified');
  assert.equal(f.calls.filter(c => c === 'submit').length, 1);
});
test('审核、拒绝、草稿、公开状态严格区分', () => {
  assert.equal(classifyStatus('审核中'), 'submitted_for_review');
  assert.equal(classifyStatus('审核未通过'), 'failed');
  assert.equal(classifyStatus('已发布'), 'published');
  assert.equal(classifyStatus(''), 'unverified');
  assert.equal(classifyStatus('', true), 'draft_saved');
});
test('正文相同但图片位置改变不能通过持久化确认', () => {
  const key = mediaKey('https://example.com/a.png');
  const expected = { schema_version: 2, contentHash: digest('["甲",["img",0],"乙"]'), linksHash: digest('[]'), images: [{ key }] };
  const actual = { ...expected, contentHash: digest('["甲乙",["img",0]]'), images: [{ key, ready: true }] };
  assert.equal(matchesSnapshot(actual, expected), false);
  actual.contentHash = expected.contentHash;
  assert.equal(matchesSnapshot(actual, expected), true);
});
test('旧版仅文本摘要不能冒充结构校验成功', () => {
  assert.equal(matchesSnapshot({ schema_version: 2, contentHash: digest('正文'), linksHash: digest('[]'), images: [] },
    { textHash: digest('正文'), linksHash: digest('[]'), images: [] }), false);
});
