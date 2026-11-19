import { join } from 'node:path';
import { openSync, closeSync, writeFileSync, fsyncSync, lstatSync, fstatSync, unlinkSync, existsSync } from 'node:fs';
import { BASE_DIR, getAccountDir, ensurePrivateDir, assertLocalPath } from './account-store.js';
import { fail } from './errors.js';

export function acquireAccountLock(account, operation, baseDir = BASE_DIR) {
  const accountDir = getAccountDir(account, baseDir);
  assertLocalPath(join(accountDir, 'operations'));
  const legacy = join(accountDir, 'operations', 'article.lock');
  assertLocalPath(legacy);
  if (existsSync(legacy)) fail('ACCOUNT_BUSY', '旧版文章操作锁仍存在，请人工核查进程和平台记录；不会自动接管');
  ensurePrivateDir(baseDir);
  const dir = ensurePrivateDir(join(baseDir, 'locks'));
  const path = join(dir, `${account}.lock`);
  let fd;
  try { fd = openSync(path, 'wx', 0o600); }
  catch (error) {
    if (error.code === 'EEXIST') fail('ACCOUNT_BUSY', '账号已有登录、检查、退出或文章操作，或有残留锁；请人工核查');
    throw error;
  }
  const owner = fstatSync(fd);
  let closed = false;
  const release = () => {
    if (closed) return;
    closed = true;
    try {
      const current = lstatSync(path);
      if (current.ino === owner.ino && current.dev === owner.dev) unlinkSync(path);
    } finally { closeSync(fd); }
  };
  try {
    writeFileSync(fd, JSON.stringify({ pid: process.pid, operation, acquired_at: new Date().toISOString() }));
    fsyncSync(fd);
  } catch (error) { release(); throw error; }
  return release;
}

export async function withAccountLock(account, operation, run, baseDir = BASE_DIR) {
  const release = acquireAccountLock(account, operation, baseDir);
  try { return await run(); } finally { release(); }
}
