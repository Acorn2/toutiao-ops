import { join } from 'node:path';
import { existsSync, renameSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { BASE_DIR, getAccountDir, readAccountMeta, bindAccount, ensurePrivateDir, isEgoProfileId, validateAccount, listAccounts as listLocalAccounts } from './account-store.js';
import { fail, OperationError } from './errors.js';
import { withAccountLock } from './account-lock.js';
import { runEgo, withEgoLock } from './ego-runtime.js';

export async function checkLogin(opts) {
  validateAccount(opts.account);
  return withAccountLock(opts.account, 'auth_check', async () => {
    const meta = readAccountMeta(opts.account);
    if (!meta?.userId || !isEgoProfileId(meta.egoProfileId)) fail('EGO_ACCOUNT_UNBOUND', '请用 auth bind-ego 绑定已登录的 Ego Profile');
    const result = await runEgo('checkProfile', { profileId: meta.egoProfileId, expectedUserId: meta.userId });
    if (!result.success) throw new OperationError(result.error_code, result.message);
    return { success: true, account: opts.account, logged_in: true, identity_verified: true, browser: 'ego', message: 'Ego Profile 的登录身份与本地绑定一致' };
  });
}

export async function bindEgo(opts) {
  const account = validateAccount(opts.account);
  if (!isEgoProfileId(opts.profileId)) fail('EGO_PROFILE_REQUIRED', '请用 --profile-id 显式指定已登录的独立 Ego Profile');
  if (opts.expectUserId && !/^\d+$/.test(opts.expectUserId)) fail('INVALID_EXPECTED_ID', '预期账号 ID 必须为数字');
  return withEgoLock(() => withAccountLock(account, 'auth_bind_ego', async () => {
    const meta = readAccountMeta(account);
    if (!meta?.userId && !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(account)) {
      fail('INVALID_ACCOUNT', '新别名须以小写英文字母开头，只用小写英文字母、数字和单个短横线分词，例如 tamen-houlai');
    }
    const expectedUserId = opts.expectUserId || meta?.userId;
    if (!expectedUserId) fail('IDENTITY_CONFIRMATION_REQUIRED', '首次绑定请显式提供 --expect-user-id');
    if (meta?.userId && expectedUserId !== meta.userId) fail('ACCOUNT_MISMATCH', '预期身份与现有别名不一致');
    if (meta?.egoProfileId != null && String(meta.egoProfileId) !== opts.profileId) fail('EGO_PROFILE_CONFLICT', '该别名已绑定另一个 Ego Profile');
    const { accounts } = await listAccounts();
    for (const entry of accounts) {
      if (!entry.usable || entry.account === account || !entry.ego_profile_bound) continue;
      const other = readAccountMeta(entry.account);
      if (String(other.egoProfileId) === opts.profileId || other.userId === expectedUserId) {
        fail('EGO_PROFILE_ALREADY_BOUND', '该 Profile 或头条号已绑定到另一个别名');
      }
    }
    const result = await runEgo('checkProfile', { profileId: opts.profileId, expectedUserId, resolveProfile: true });
    if (!result.success) throw new OperationError(result.error_code, result.message);
    bindAccount(account, { userId: expectedUserId, username: result.display_name }, expectedUserId, result.profile_id);
    return { success: true, account, identity_verified: true, browser: 'ego', message: '已绑定独立 Ego Profile' };
  }));
}

export async function doLogout(opts) {
  validateAccount(opts.account);
  return withAccountLock(opts.account, 'auth_logout', async () => {
    const dir = getAccountDir(validateAccount(opts.account));
    if (existsSync(dir)) {
      const archive = ensurePrivateDir(join(BASE_DIR, 'archive'));
      renameSync(dir, join(archive, `${opts.account}-${randomUUID()}`));
    }
    return { success: true, account: opts.account, message: '本地账号目录已归档，Ego Profile 仍由浏览器管理' };
  });
}

export function listAccounts() { return listLocalAccounts(); }
