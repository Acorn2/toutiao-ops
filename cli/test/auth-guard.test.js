import test from 'node:test';
import assert from 'node:assert/strict';
import { MP_HOME, openAccountSignIn } from '../src/auth-guard.js';

const loginPage = 'https://mp.toutiao.com/auth/page/login';

function browserPage({ state = 'signed_out', ok = true } = {}) {
  const destinations = [];
  let current;
  const timeout = () => { throw new Error('fixture timed out'); };
  return {
    destinations,
    async goto(url) {
      destinations.push(url);
      current = state === 'redirect' && url === MP_HOME ? loginPage : url;
      return { ok: () => ok };
    },
    url: () => current,
    locator: () => ({ first: () => ({ waitFor: async () => {
      if (state !== 'signed_in' || current !== MP_HOME) timeout();
    } }) }),
    async waitForURL(match) {
      if (!match(new URL(current))) timeout();
    },
  };
}

test('登录指令在未跳转的后台空壳页回退到官方登录入口', async () => {
  const page = browserPage();
  assert.equal(await openAccountSignIn(page), true);
  assert.deepEqual(page.destinations, [MP_HOME, loginPage]);
});

test('已有会话或登录重定向时不额外打开登录入口', async () => {
  for (const [state, needsScan] of [['signed_in', false], ['redirect', true]]) {
    const page = browserPage({ state });
    assert.equal(await openAccountSignIn(page), needsScan);
    assert.deepEqual(page.destinations, [MP_HOME]);
  }
});

test('后台响应失败时保留登录错误，不把错误页面当作未登录空壳', async () => {
  const page = browserPage({ ok: false });
  await assert.rejects(openAccountSignIn(page), { code: 'AUTH_STATE_UNAVAILABLE' });
  assert.deepEqual(page.destinations, [MP_HOME]);
});
