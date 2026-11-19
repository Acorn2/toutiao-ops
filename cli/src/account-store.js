import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { existsSync, lstatSync, mkdirSync, chmodSync, readFileSync, writeFileSync, renameSync, openSync, closeSync, fsyncSync, readdirSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { fail, errorCode } from './errors.js';

export const BASE_DIR = join(homedir(), '.toutiao-ops');
export const PRIVATE_JSON_LIMIT = 1024 * 1024;

export function validateAccount(account) {
  if (typeof account !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(account)) {
    fail('INVALID_ACCOUNT', '账号别名须为 1–64 位小写字母、数字、下划线或连字符；不自动转换旧别名');
  }
  return account;
}

export function isEgoProfileId(profileId) {
  return typeof profileId === 'string' && /^(?:[\w.-]{1,128}|Profile [0-9]{1,120})$/.test(profileId)
    || typeof profileId === 'number' && Number.isSafeInteger(profileId) && profileId >= 0;
}

export function assertLocalPath(path) {
  if (existsSync(path) || (() => { try { lstatSync(path); return true; } catch { return false; } })()) {
    if (lstatSync(path).isSymbolicLink()) fail('UNSAFE_SESSION_PATH', '会话路径不允许符号链接');
  }
  return path;
}

export function getAccountDir(account = 'default', baseDir = BASE_DIR) {
  validateAccount(account);
  const accountsDir = join(baseDir, 'accounts');
  for (const path of [baseDir, accountsDir, join(accountsDir, account)]) assertLocalPath(path);
  if (existsSync(accountsDir) && readdirSync(accountsDir).some(name => name !== account && name.toLowerCase() === account)) {
    fail('ACCOUNT_ALIAS_COLLISION', '存在仅大小写不同的旧账号目录，停止操作；请人工核查，不会复用或迁移会话');
  }
  return join(accountsDir, account);
}

// mkdir without recursively following existing symlinks, including existing directories.
export function ensurePrivateDir(path) {
  assertLocalPath(path);
  if (!existsSync(path)) {
    if (!existsSync(dirname(path))) ensurePrivateDir(dirname(path));
    mkdirSync(path, { mode: 0o700 });
  }
  if (!lstatSync(path).isDirectory()) fail('UNSAFE_SESSION_PATH', '会话目录类型错误');
  chmodSync(path, 0o700);
  return path;
}

export function prepareAccount(account) {
  const dir = getAccountDir(account);
  for (const path of [BASE_DIR, join(BASE_DIR, 'accounts'), dir]) ensurePrivateDir(path);
  return dir;
}

export function readPrivateJson(path) {
  assertLocalPath(path);
  if (!existsSync(path)) return null;
  if (!lstatSync(path).isFile() || lstatSync(path).size > PRIVATE_JSON_LIMIT) fail('LOCAL_STATE_INVALID', '本地状态须为不超过 1 MiB 的普通 JSON 文件');
  chmodSync(path, 0o600);
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch { fail('LOCAL_STATE_INVALID', '本地账号或操作记录损坏，请人工检查后再操作'); }
}

export function writePrivateText(path, value) {
  assertLocalPath(path);
  ensurePrivateDir(dirname(path));
  const temporary = join(dirname(path), `.write-${randomUUID()}.tmp`);
  const descriptor = openSync(temporary, 'wx', 0o600);
  try { writeFileSync(descriptor, value); fsyncSync(descriptor); }
  finally { closeSync(descriptor); }
  renameSync(temporary, path);
}

export function writePrivateJson(path, value) {
  writePrivateText(path, JSON.stringify(value, null, 2));
}

export function readAccountMeta(account, baseDir = BASE_DIR) {
  return readPrivateJson(join(getAccountDir(account, baseDir), 'meta.json'));
}

export function egoBindingKey(meta) {
  if (!/^\d+$/.test(meta?.userId || '') || meta?.egoProfileId == null) return null;
  return createHash('sha256').update(JSON.stringify([meta.userId, meta.egoProfileId])).digest('hex');
}

export function listAccounts(baseDir = BASE_DIR) {
  assertLocalPath(baseDir);
  const base = assertLocalPath(join(baseDir, 'accounts'));
  const accounts = [];
  if (!existsSync(base)) return { success: true, accounts, count: 0 };
  for (const entry of readdirSync(base, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const account = entry.name;
    try {
      const path = getAccountDir(account, baseDir);
      const meta = readAccountMeta(account, baseDir);
      accounts.push({ account, usable: true, has_session: existsSync(assertLocalPath(join(path, 'browser-data'))),
        ego_profile_bound: !!egoBindingKey(meta), identity_bound: !!meta?.userId, last_login: meta?.lastLogin || null });
    } catch (error) { accounts.push({ account, usable: false, error_code: errorCode(error) }); }
  }
  return { success: true, accounts, count: accounts.length };
}

export function bindAccount(account, identity, expectedUserId, egoProfileId) {
  if (!identity?.userId) fail('IDENTITY_UNAVAILABLE', '无法提取稳定账号 ID，请人工确认后台身份');
  const previous = readAccountMeta(account);
  if (!previous?.userId && !expectedUserId) fail('IDENTITY_CONFIRMATION_REQUIRED', '首次绑定必须提供 --expect-user-id，以确认扫码账号身份');
  if ((previous?.userId && previous.userId !== identity.userId) || (expectedUserId && expectedUserId !== identity.userId)) {
    fail('ACCOUNT_MISMATCH', '当前登录身份与账号别名绑定不一致；请使用独立别名');
  }
  if (egoProfileId != null && previous?.egoProfileId != null && previous.egoProfileId !== egoProfileId) {
    fail('EGO_PROFILE_CONFLICT', '该别名已绑定另一个 Ego Profile');
  }
  const profileId = egoProfileId ?? previous?.egoProfileId;
  writePrivateJson(join(prepareAccount(account), 'meta.json'), {
    userId: identity.userId, username: identity.username || previous?.username || '', lastLogin: new Date().toISOString(),
    ...(profileId != null ? { egoProfileId: profileId } : {}),
  });
}
