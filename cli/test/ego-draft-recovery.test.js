import test from 'node:test';
import assert from 'node:assert/strict';
import { EgoDraftPage } from '../src/ego-draft-page.js';
import { contentSnapshot } from '../src/article-records.js';
import { executeArticle } from '../src/article-workflow.js';

const snapshot = contentSnapshot({ structure: ['正文'], links: [], images: [] });
const expected = { title: '模拟草稿', images: [], snapshot };

test('Ego 仅在已确认草稿 ID 后恢复 7050，相同草稿最多重开三次', async () => {
  for (const scenario of ['no_id', 'recovered', 'repeated']) {
    const driver = new EgoDraftPage({ page: () => ({}) }, '100');
    driver.draftId = scenario === 'no_id' ? null : '200';
    let reads = 0;
    driver.observeDraftSave = async (version, reject) => {
      assert.equal(version.draftId, driver.draftId);
      if (++reads === 2 && scenario === 'recovered') return { accepted: { draftId: '200', sequence: 2 }, pendingSequences: [] };
      reject(1, { response: { code: 7050 } });
      return { accepted: null, pendingSequences: [] };
    };
    driver.reopenDraft = async () => { driver.draftReopens++; return false; };
    const checkpoints = [];
    driver.persistCheckpoint = (id, checkpoint) => checkpoints.push({ id, checkpoint });
    const saving = driver.confirmSave('text', expected, true);
    if (scenario === 'recovered') {
      await saving;
      assert.equal(checkpoints[0].id, '200');
      assert.equal(checkpoints[0].checkpoint.stage, 'text');
      assert.deepEqual(checkpoints[0].checkpoint.snapshot, snapshot);
    } else {
      await assert.rejects(saving, { code: 'DRAFT_SAVE_7050_UNCONFIRMED' });
      assert.equal(checkpoints.length, 0);
    }
    assert.equal(driver.keepEditorOpen, true);
    assert.equal(driver.rejectedAutosave.response.code, 7050);
    assert.equal(driver.draftReopens, { no_id: 0, recovered: 1, repeated: 3 }[scenario]);
  }
});

test('重新启动后按已绑定账号和已有草稿 ID 只读报告缺失的图注', async () => {
  const state = { sources: [{ ready: true, uri: 'tos-test/1', caption: '' }], covers: [], html: '<p>正文</p>' };
  let storedId = '200';
  const detail = {
    url: async () => 'https://mp.toutiao.com/profile_v4/graphic/publish?pgc_id=' + storedId,
    waitForURL: async () => {}, waitForFunction: async () => true,
    evaluate: async fn => {
      if (fn.name === 'readEgoMedia') return state;
      if (fn.name === 'inspectContent') return { structure: ['正文'], links: [], images: [] };
      return { challenge: false, login: false };
    },
  };
  const page = {
    goto: async () => {}, waitForSelector: async () => {}, waitForFunction: async () => true,
    waitForEvent: async () => detail,
    click: async (_selector, opts) => { assert.ok(['打开头条号草稿箱', '重开已保存的草稿'].includes(opts.label)); },
    evaluate: async fn => {
      if (fn.name === 'inspectIdentityLink') return { userId: '100' };
      if (fn.name === 'draftListState') return [1];
      return { challenge: false, login: false };
    },
  };
  let entry = { action: 'draft_save', article_id: '200', state: 'unverified' };
  const store = { read: () => entry, write: value => { entry = value; } };
  const reopen = () => executeArticle({ draft: true, account: 'fixture', reconcileOnly: true },
    { title: '模拟草稿', images: [{ marker: '图1' }] }, new EgoDraftPage({ page: () => page }, '100'), store);
  const matched = await reopen();
  assert.equal(matched.status, 'unverified');
  assert.deepEqual(matched.diagnostic.lookup.persisted.empty_caption_positions, [1]);
  storedId = '201';
  assert.equal((await reopen()).diagnostic.lookup.persisted, undefined);
  assert.equal(entry.article_id, '200');
});
