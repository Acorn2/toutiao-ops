import { join } from 'node:path';
import { openSync, closeSync, unlinkSync } from 'node:fs';
import { prepareAccount, ensurePrivateDir, readPrivateJson, writePrivateJson } from './account-store.js';
import { fail } from './errors.js';
import { acquireAccountLock } from './account-lock.js';

export function openOperation(account, signature) {
  const release = acquireAccountLock(account, 'article');
  try {
    const dir = ensurePrivateDir(join(prepareAccount(account), 'operations'));
    const store = openOperationAt(dir, signature);
    return { ...store, close() { try { store.close(); } finally { release(); } } };
  } catch (error) { release(); throw error; }
}

export function openOperationAt(dir, signature) {
  if (!/^[a-f0-9]{64}$/.test(signature)) fail('INVALID_OPERATION_KEY', '操作记录键必须是内容 SHA-256');
  ensurePrivateDir(dir);
  const path = join(dir, `${signature}.json`);
  const lock = join(dir, 'article.lock');
  let descriptor;
  try { descriptor = openSync(lock, 'wx', 0o600); }
  catch (error) {
    if (error.code === 'EEXIST') fail('ACCOUNT_BUSY', '账号已有文章操作或上次异常退出残留锁；请人工核查进程和后台结果');
    throw error;
  }
  return {
    read: () => readPrivateJson(path),
    write: entry => writePrivateJson(path, entry),
    close() { closeSync(descriptor); unlinkSync(lock); },
  };
}
