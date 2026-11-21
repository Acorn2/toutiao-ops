import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { inspectIdentityLink, IDENTITY_LINK } from '../src/auth-guard.js';

test('Ego 只从唯一可信的头条主页链接读取数字身份', () => {
  function inspect(...urls) {
    const document = { querySelectorAll(selector) {
      assert.equal(selector, IDENTITY_LINK);
      return urls.map(href => ({ href, closest: () => null, textContent: ' 测试号 ' }));
    } };
    return runInNewContext('(' + inspectIdentityLink.toString() + ')(selector)', { URL, document, selector: IDENTITY_LINK });
  }
  const url = 'https://www.toutiao.com/c/user/123/';
  assert.equal(inspect(url).userId, '123');
  for (const inputs of [[], [url, url], [url.replace('https:', 'http:')], [url.replace('www.toutiao.com', 'example.com')], [url + 'profile']]) {
    assert.equal(inspect(...inputs), null);
  }
});
