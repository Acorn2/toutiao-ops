import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, statSync, mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { openOperationAt } from '../src/operation-store.js';
import { acquireAccountLock } from '../src/account-lock.js';
import { getAccountDir } from '../src/account-store.js';

test('同账号操作互斥，结束后记录持久化，另一账号不受影响', () => {
  const dir = mkdtempSync(join(tmpdir(), 'toutiao-operation-'));
  const key = 'a'.repeat(64);
  const first = openOperationAt(join(dir, 'account_a'), key);
  first.write({ state: 'unverified', action: 'draft_save' });
  assert.throws(() => openOperationAt(join(dir, 'account_a'), 'b'.repeat(64)), { code: 'ACCOUNT_BUSY' });
  const other = openOperationAt(join(dir, 'account_b'), key);
  assert.equal(other.read(), null); other.close();
  first.close();
  const resumed = openOperationAt(join(dir, 'account_a'), key);
  assert.deepEqual(resumed.read(), { state: 'unverified', action: 'draft_save' });
  assert.equal(statSync(join(dir, 'account_a', `${key}.json`)).mode & 0o777, 0o600);
  resumed.close();
});
test('拒绝操作键中的路径逃逸', () => {
  assert.throws(() => openOperationAt(tmpdir(), '../meta'), { code: 'INVALID_OPERATION_KEY' });
});
test('文章执行期间登录、检查和退出共享同一账号锁，其他账号独立', () => {
  const dir = mkdtempSync(join(tmpdir(), 'toutiao-account-lock-'));
  const release = acquireAccountLock('account_a', 'article', dir);
  for (const operation of ['auth_bind_ego', 'auth_check', 'auth_logout', 'article']) {
    assert.throws(() => acquireAccountLock('account_a', operation, dir), { code: 'ACCOUNT_BUSY' });
  }
  const lock = join(dir, 'locks', 'account_a.lock');
  assert.equal(JSON.parse(readFileSync(lock)).pid, process.pid);
  assert.equal(statSync(lock).mode & 0o777, 0o600);
  const other = acquireAccountLock('account_b', 'auth_logout', dir); other();
  release();
  assert.equal(existsSync(lock), false);
  const resumed = acquireAccountLock('account_a', 'auth_logout', dir); resumed();
});
test('拒绝旧版大小写目录冲突及旧版未释放的文章锁', () => {
  const dir = mkdtempSync(join(tmpdir(), 'toutiao-alias-'));
  mkdirSync(join(dir, 'accounts'));
  mkdirSync(join(dir, 'accounts', 'Account_A'));
  assert.throws(() => getAccountDir('Account_A', dir), { code: 'INVALID_ACCOUNT' });
  assert.throws(() => getAccountDir('account_a', dir), { code: 'ACCOUNT_ALIAS_COLLISION' });
  assert.throws(() => acquireAccountLock('account_a', 'auth_bind_ego', dir), { code: 'ACCOUNT_ALIAS_COLLISION' });
  assert.equal(existsSync(join(dir, 'accounts', 'account_a', 'meta.json')), false);
  const operations = join(dir, 'accounts', 'account_b', 'operations');
  mkdirSync(operations, { recursive: true });
  writeFileSync(join(operations, 'article.lock'), 'legacy');
  assert.throws(() => acquireAccountLock('account_b', 'auth_logout', dir), { code: 'ACCOUNT_BUSY' });
});
test('另一个 CLI 进程不能绕过账号锁执行退出', () => {
  const dir = mkdtempSync(join(tmpdir(), 'toutiao-process-lock-'));
  const release = acquireAccountLock('account_a', 'article', dir);
  try {
    const script = `import { acquireAccountLock } from './src/account-lock.js'; try { const close = acquireAccountLock('account_a', 'auth_logout', process.argv[1]); close(); process.exitCode = 1; } catch (error) { process.stdout.write(error.code); }`;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', script, dir], { encoding: 'utf8' });
    assert.equal(child.status, 0, child.stderr);
    assert.equal(child.stdout, 'ACCOUNT_BUSY');
  } finally { release(); }
});
