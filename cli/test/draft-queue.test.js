import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDraftQueue } from '../src/draft-queue.js';
import { writePrivateJson } from '../src/account-store.js';

function fixture(publish) {
  const baseDir = mkdtempSync(join(tmpdir(), 'toutiao-draft-queue-'));
  const bind = (alias, userId, egoProfileId) => writePrivateJson(join(baseDir, 'accounts', alias, 'meta.json'), { userId, egoProfileId });
  bind('account_a', '100', 'ego-a');
  bind('account_b', '200', 'ego-b');
  const makeFile = (name, body) => {
    const file = join(baseDir, `${name}.md`);
    writeFileSync(file, body);
    return file;
  };
  const options = { baseDir, publish };
  return { options, bind, queue: createDraftQueue(options), makeFile };
}

const verified = account => ({ success: true, action: 'draft_save', account, status: 'draft_saved', verified: true,
  article_id: '9001', url: 'https://mp.toutiao.com/profile_v4/graphic/publish?pgc_id=9001&ignored=irrelevant' });

test('打开总览前刷新同一文件，刷新失败时不打开浏览器', async () => {
  const f = fixture();
  const { overview_file: file } = f.queue.overview();
  writeFileSync(file, '旧快照');
  const paths = [];
  const queue = createDraftQueue({ ...f.options, openBrowser: async path => {
    paths.push(path);
    assert.match(readFileSync(path, 'utf8'), /发稿总览/);
  } });
  assert.equal((await queue.open()).opened, true);
  assert.deepEqual(paths, [file]);

  const blocked = fixture();
  const directory = join(blocked.options.baseDir, 'draft-queue');
  mkdirSync(directory);
  symlinkSync(file, join(directory, 'overview.html'));
  const notOpened = createDraftQueue({ ...blocked.options, openBrowser: async path => { paths.push(path); } });
  assert.equal((await notOpened.open()).error_code, 'DRAFT_OVERVIEW_WRITE_FAILED');
  assert.deepEqual(paths, [file]);
});

test('默认浏览器启动失败时仍返回已刷新的本地文件路径', async () => {
  const f = fixture();
  const queue = createDraftQueue({ ...f.options, openBrowser: async () => { throw new Error('not available'); } });
  const result = await queue.open();
  assert.equal(result.opened, false);
  assert.equal(result.success, false);
  assert.equal(result.error_code, 'DRAFT_OVERVIEW_OPEN_FAILED');
  assert.match(readFileSync(result.overview_file, 'utf8'), /发稿总览/);
});

test('队列按账号登记和去重，核对结果与登录异常出现在同一个离线总览', async () => {
  const calls = [];
  const f = fixture(async opts => {
    calls.push(opts);
    return opts.account === 'account_a' ? verified(opts.account) : { success: false, status: 'failed', error_code: 'AUTH_REQUIRED' };
  });
  const contentFile = f.makeFile('first', '# 开发随记\n\n今天完成一项本地改进。');
  const first = await f.queue.add({ account: 'account_a', contentFile });
  const duplicate = await f.queue.add({ account: 'account_a', contentFile });
  const second = await f.queue.add({ account: 'account_b', contentFile });
  assert.equal(first.task.id, duplicate.task.id);
  assert.equal(duplicate.already_queued, true);
  assert.notEqual(first.task.id, second.task.id);
  assert.equal(f.queue.overview().counts.pending, 2);
  assert.equal(calls.length, 0);
  await f.queue.run({ account: 'account_a' });
  const pending = createDraftQueue(f.options).overview();
  assert.deepEqual(pending.counts, { pending: 1, running: 0, verified: 1, needs_attention: 0 });
  assert.equal(pending.accounts.find(group => group.account === 'account_a').tasks[0].draft_url,
    'https://mp.toutiao.com/profile_v4/graphic/publish?pgc_id=9001');
  assert.equal(calls[0].title, undefined); // Keep H1 extraction on the execution path.
  assert.equal(calls[0].draft, true);
  assert.equal(calls[0].browser, 'ego');
  assert.equal(calls[0].publish, undefined);
  assert.match(calls[0].expectedBinding, /^[a-f0-9]{64}$/);
  assert.equal((await f.queue.run({ account: 'account_b' })).status, 'failed');
  const report = createDraftQueue(f.options).overview();
  assert.equal(report.counts.needs_attention, 1);
  const html = readFileSync(report.overview_file, 'utf8');
  assert.match(html, /需要处理/);
  assert.match(html, /重新登录/);
  assert.match(html, /草稿已核对/);
  assert.doesNotMatch(html, /ignored=|ego-a|今天完成一项本地改进/);
  assert.equal(statSync(report.overview_file).mode & 0o777, 0o600);
});

test('作品快照只读取已绑定的账号，失败保留上次成功结果，换绑后不显示旧内容', async () => {
  const f = fixture();
  const calls = [];
  let offline = false;
  const queue = createDraftQueue({ ...f.options, openBrowser: async () => {}, readPublications: async payload => {
    calls.push(payload);
    return offline ? { success: false, error_code: 'AUTH_REQUIRED' } : {
      success: true, display_name: payload.expectedUserId === '100' ? '示例手记' : '示例观察',
      total: 1, articles: [{ title: '已发表的文章', url: 'https://www.toutiao.com/item/9001/' }],
    };
  } });
  const first = await queue.open({ sync: true });
  assert.equal(first.opened, true);
  assert.deepEqual(calls.map(item => item.profileId), ['ego-a', 'ego-b']);
  assert.equal(first.accounts[0].publications.total, 1);
  assert.match(readFileSync(first.overview_file, 'utf8'), /示例手记/);
  offline = true;
  const second = await queue.open({ sync: true });
  assert.equal(second.sync_failures.length, 2);
  assert.equal(second.accounts[0].publications.articles[0].title, '已发表的文章');
  f.bind('account_a', '300', 'another-profile');
  assert.equal(queue.overview().accounts[0].publications, null);
});

test('中断或未确认的任务按编号恢复时仅回查，并阻止未经验证的草稿链接', async () => {
  const attempts = [];
  const f = fixture(async opts => {
    attempts.push(opts.reconcileOnly);
    return attempts.length === 1 ? { success: false, status: 'unverified', error_code: 'PERSISTENCE_UNVERIFIED', diagnostic: { lookup: { found: true } } }
      : { ...verified(opts.account), url: 'https://example.com/?pgc_id=9001' };
  });
  const { task } = await f.queue.add({ account: 'account_a', contentFile: f.makeFile('draft', '# 试稿\n\n两段正文。') });
  const attempt = await f.queue.run({ account: 'account_a' });
  assert.equal(attempt.status, 'unverified');
  assert.equal(attempt.tasks[0].draft_found, true);
  assert.equal((await f.queue.run({ account: 'account_a' })).tasks.length, 0);
  const recovered = await f.queue.run({ account: 'account_a', id: task.id });
  assert.deepEqual(attempts, [false, true]);
  assert.equal(recovered.tasks[0].status, 'unverified');
  assert.equal(recovered.tasks[0].draft_url, null);
  await assert.rejects(f.queue.run({ account: 'account_b', id: task.id }), { code: 'DRAFT_JOB_NOT_FOUND' });
});

test('账号重新绑定或稿件版本变化后，在浏览器启动前停止', async () => {
  const f = fixture(); // Use the actual publishArticle entry; both failures are offline.
  const contentFile = f.makeFile('change', '# 原始稿件\n\n第一版内容。');
  const first = await f.queue.add({ account: 'account_a', contentFile });
  await f.queue.add({ account: 'account_b', contentFile });
  f.bind('account_a', '100', 'another-profile');
  writeFileSync(contentFile, '# 原始稿件\n\n第二版内容。');
  assert.equal(f.queue.overview().counts.needs_attention, 1);
  const a = await f.queue.run({ account: 'account_a', id: first.task.id });
  assert.equal(a.tasks[0].error_code, 'DRAFT_BINDING_CHANGED');
  const b = await f.queue.run({ account: 'account_b' });
  assert.equal(b.tasks[0].error_code, 'DRAFT_SOURCE_CHANGED');
  assert.equal(f.queue.overview().counts.needs_attention, 2);
});
