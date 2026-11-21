import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { writePrivateJson } from '../src/account-store.js';
import { createWorkspaceData } from '../src/workspace-data.js';
import { createWorkspaceServer } from '../src/workspace-server.js';
import { openWorkspaceDraft } from '../src/ego-worker.js';
import { readDraftList } from '../src/ego-draft-page.js';

test('工作台同步合并请求、锁定账号并保留上次结果，换绑后无法打开旧草稿', async () => {
  const baseDir = mkdtempSync(join(tmpdir(), 'toutiao-workspace-'));
  const bind = (userId, egoProfileId) => writePrivateJson(join(baseDir, 'accounts', 'account_b', 'meta.json'), { userId, egoProfileId });
  bind('200', 'ego-b');
  const calls = [];
  let expired = false;
  const data = createWorkspaceData({ baseDir, browser: async (method, payload) => {
    calls.push({ method, payload });
    if (method === 'openWorkspaceDraft') return { success: true };
    if (expired) return { success: false, error_code: 'AUTH_REQUIRED' };
    return { success: true, display_name: '账号乙', drafts: { rows: [{ id: '42', title: 'CLI 直接保存的草稿' }] },
      publications: { total: 1, articles: [{ title: '乙号已发文章', url: 'https://www.toutiao.com/item/100/' }] } };
  } });
  assert.equal(data.overview().accounts[0].drafts, null);
  const [first, second] = await Promise.all([data.sync('account_b'), data.sync('account_b')]);
  assert.deepEqual(first, second);
  assert.equal(first.user_id, '200');
  assert.equal(first.drafts.rows[0].title, 'CLI 直接保存的草稿');
  assert.equal(first.tasks.length, 0);
  assert.equal(first.publications.total, 1);
  assert.deepEqual(calls, [{ method: 'readWorkspace', payload: { profileId: 'ego-b', expectedUserId: '200' } }]);
  assert.deepEqual(await data.openDraft('account_b', 'id:42'), { success: true });
  assert.deepEqual(calls[1], { method: 'openWorkspaceDraft', payload: {
    profileId: 'ego-b', expectedUserId: '200', draft: { id: '42', title: 'CLI 直接保存的草稿' },
  } });
  expired = true;
  const stale = await data.sync('account_b');
  assert.equal(stale.drafts.synced_at, first.drafts.synced_at);
  assert.deepEqual(stale.drafts.rows, first.drafts.rows);
  assert.equal(stale.drafts.sync_error, 'AUTH_REQUIRED');
  assert.equal(stale.publications.sync_error, 'AUTH_REQUIRED');
  bind('300', 'ego-new');
  assert.equal(data.overview().accounts[0].drafts, null);
  await assert.rejects(data.openDraft('account_b', 'id:42'), { code: 'DRAFT_LIST_CHANGED' });
});

test('本机服务提供 Vue，且只让同源 JSON 请求触发 Ego', async t => {
  const calls = [];
  const server = createWorkspaceServer({
    overview: () => ({ accounts: [] }),
    sync: async account => { calls.push(account); return { account }; },
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const root = await fetch(origin);
  assert.match(root.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.match(root.headers.get('content-security-policy'), /(?:^|; )img-src 'self';/);
  const html = await root.text();
  assert.match(html, /发稿工作台/);
  assert.match(html, /<link rel="icon" type="image\/svg\+xml" href="\/logo\.svg">/);
  const logo = await fetch(origin + '/logo.svg');
  assert.equal(logo.status, 200);
  assert.equal(logo.headers.get('content-type'), 'image/svg+xml');
  assert.match(await logo.text(), /^<svg\b/);
  const vue = await fetch(origin + '/vue.js');
  assert.equal(vue.status, 200);
  assert.match(await vue.text(), /createApp/);
  const data = await fetch(origin + '/api/workspace');
  assert.deepEqual(await data.json(), { accounts: [] });

  const post = (requestOrigin, body) => fetch(origin + '/api/sync', {
    method: 'POST', headers: { Origin: requestOrigin, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  assert.equal((await post('https://example.com', { account: 'account_b' })).status, 403);
  assert.equal((await post(origin, {})).status, 400);
  assert.deepEqual(calls, []);
  assert.deepEqual(await (await post(origin, { account: 'account_b' })).json(), { account: 'account_b' });
  assert.deepEqual(calls, ['account_b']);
});

test('草稿列表必须已激活且完整，打开时检查同一 Profile、草稿 ID 和标题', async () => {
  let count = 2;
  const visible = { getBoundingClientRect: () => ({ height: 20 }) };
  const row = { ...visible, matches: () => true, querySelector: selector => selector === 'a.title'
    ? { textContent: '草稿甲' } : { href: 'https://mp.toutiao.com/profile_v4/graphic/publish?pgc_id=42' } };
  const view = { ...visible, getAttribute: () => null, querySelector: selector => ({
    ':scope > .list': { children: [row] }, ':scope > .list-count': { innerText: `共 ${count} 条内容` },
  })[selector] };
  const document = { querySelector: selector => selector.endsWith('.active') ? visible : view };
  const location = { pathname: '/profile_v4/manage/draft', origin: 'https://mp.toutiao.com' };
  const evaluate = (fn, args) => runInNewContext(`(${fn.toString()})(args)`, { URL, document, location, args,
    getComputedStyle: () => ({ visibility: 'visible' }) });
  const page = {
    goto: async () => {}, waitForSelector: async () => {}, click: async () => ({ popups: [{ label: 'p2' }] }),
    waitForEvent: async () => null,
    waitForFunction: async (fn, args) => { if (!evaluate(fn, args)) throw Error('还未加载'); },
    evaluate: async (fn, args) => fn.name === 'draftListState' ? evaluate(fn, args)
      : args ? { userId: '200' } : { challenge: false, login: false },
  };
  await assert.rejects(readDraftList(page), { code: 'LIST_VIEW_UNVERIFIED' });
  count = 1;
  assert.equal((await readDraftList(page))[0].id, '42');

  let editorId = '99';
  let editorTitle = '草稿甲';
  const editor = {
    label: 'p2', waitForURL: async () => {}, evaluate: async () => ({ challenge: false, login: false }),
    url: async () => `https://mp.toutiao.com/profile_v4/graphic/publish?pgc_id=${editorId}`,
    waitForFunction: async (_fn, args) => { if (args.title !== editorTitle) throw Error('标题不同'); },
  };
  const keep = [];
  const sdk = { taskSpace: async (_name, { profileId }) => {
    assert.equal(profileId, 'ego-b');
    return { page: label => label === 'p1' ? page : editor, finish: async options => keep.push(options.keep) };
  } };
  const input = { profileId: 'ego-b', expectedUserId: '200', draft: { title: '草稿甲', id: '42' } };
  assert.equal((await openWorkspaceDraft(sdk, input)).error_code, 'DRAFT_LIST_CHANGED');
  editorId = '42';
  editorTitle = '另一份草稿';
  assert.equal((await openWorkspaceDraft(sdk, input)).error_code, 'DRAFT_LIST_CHANGED');
  editorTitle = '草稿甲';
  assert.deepEqual(await openWorkspaceDraft(sdk, input), { success: true });
  assert.deepEqual(keep, [[], [], ['p2']]);
});
