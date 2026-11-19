import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkProfile, listPublications } from '../src/ego-worker.js';

test('Ego 核对会话只打开指定的 Profile，每个 Profile 单独校验头条号 ID', async () => {
  const opened = [];
  const sdk = {
    profiles: async () => [{ id: 'Default' }, { id: 'Profile 2' }],
    async taskSpace(_name, { profileId }) {
      opened.push(profileId);
      return {
        page() {
          return { goto: async () => {}, waitForSelector: async () => {},
            evaluate: async (_fn, args) => args ? { userId: profileId === 'Default' ? '100' : '200' } : { challenge: false, login: false } };
        },
        finish: async () => {},
      };
    },
  };
  assert.equal((await checkProfile(sdk, { profileId: 'Default', expectedUserId: '100', resolveProfile: true })).success, true);
  assert.equal((await checkProfile(sdk, { profileId: 'Profile 2', expectedUserId: '200', resolveProfile: true })).success, true);
  assert.equal((await checkProfile(sdk, { profileId: 'Profile 2', expectedUserId: '100', resolveProfile: true })).error_code, 'ACCOUNT_MISMATCH');
  assert.equal((await checkProfile(sdk, { profileId: 'Profile 3', expectedUserId: '100', resolveProfile: true })).error_code, 'EGO_PROFILE_UNAVAILABLE');
  assert.deepEqual(opened, ['Default', 'Profile 2', 'Profile 2']);
});

test('Ego 作品同步逐页读完数百篇后才交付快照', async () => {
  const total = 305;
  let current = 0;
  let events = [];
  const page = {
    goto: async () => {},
    waitForSelector: async () => {},
    cdp: async () => {},
    async waitForFunction(_fn, args) {
      if (args.requirePublished) assert.equal(args.pageNumber, current);
    },
    async click(selector) {
      assert.match(selector, current === 0 ? /已发布/ : /item-icon:last-child/);
      current++;
      events = [
        { method: 'Network.responseReceived', params: { requestId: current, response: { url: 'https://mp.toutiao.com/api/feed/mp_provider/v1/', status: 200 } } },
        { method: 'Network.loadingFinished', params: { requestId: current } },
      ];
    },
    async events() {
      const pending = events;
      events = [];
      return pending;
    },
    async evaluate(fn, args) {
      if (fn.name !== 'readPublishedList') return args ? { userId: '100' } : { challenge: false, login: false };
      const start = (current - 1) * 10;
      return { total, articles: Array.from({ length: Math.min(10, total - start) }, (_, index) => ({
        title: `文章 ${start + index + 1}`, url: `https://www.toutiao.com/item/${start + index + 100}/`,
      })) };
    },
  };
  const sdk = { taskSpace: async () => ({ page: () => page, finish: async () => {} }) };
  const result = await listPublications(sdk, { profileId: 'Default', expectedUserId: '100' });
  assert.equal(result.success, true);
  assert.equal(current, 31);
  assert.equal(result.articles.length, total);
  assert.equal(result.articles.at(-1).title, '文章 305');
});
