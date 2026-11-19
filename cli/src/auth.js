import { join } from 'node:path';
import { existsSync, renameSync, chmodSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { launchBrowser, getScreenshotDir } from './browser.js';
import { BASE_DIR, getAccountDir, readAccountMeta, bindAccount, ensurePrivateDir, isEgoProfileId, validateAccount, listAccounts as listLocalAccounts } from './account-store.js';
import { MP_HOME, ensureLoggedIn, openAccountSignIn, readIdentity, verifyIdentity } from './auth-guard.js';
import { fail, OperationError } from './errors.js';
import { withAccountLock } from './account-lock.js';
import { runEgo, withEgoLock } from './ego-runtime.js';

export async function checkLogin(opts) {
  validateAccount(opts.account);
  return withAccountLock(opts.account, 'auth_check', async () => {
    const meta = readAccountMeta(opts.account);
    if (meta?.egoProfileId != null) {
      const result = await runEgo('checkProfile', { profileId: meta.egoProfileId, expectedUserId: meta.userId });
      if (!result.success) throw new OperationError(result.error_code, result.message);
      return { success: true, account: opts.account, logged_in: true, identity_verified: true, browser: 'ego', message: 'Ego Profile 的登录身份与本地绑定一致' };
    }
    const { context, page } = await launchBrowser(opts);
    try {
      const identity = await ensureLoggedIn(page);
      verifyIdentity(identity, meta);
      return { success: true, account: opts.account, logged_in: true, identity_verified: true, message: '登录身份与本地绑定一致' };
    } finally { await context.close(); }
  });
}

export async function bindEgo(opts) {
  const account = validateAccount(opts.account);
  if (!isEgoProfileId(opts.profileId)) fail('EGO_PROFILE_REQUIRED', '请用 --profile-id 显式指定已登录的独立 Ego Profile');
  if (opts.expectUserId && !/^\d+$/.test(opts.expectUserId)) fail('INVALID_EXPECTED_ID', '预期账号 ID 必须为数字');
  return withEgoLock(() => withAccountLock(account, 'auth_bind_ego', async () => {
    const meta = readAccountMeta(account);
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

export async function doLogin(opts) {
  validateAccount(opts.account);
  if (opts.expectUserId && !/^\d+$/.test(opts.expectUserId)) fail('INVALID_EXPECTED_ID', '预期账号 ID 必须是平台主页中的数字 ID');
  if (!readAccountMeta(opts.account)?.userId && !opts.expectUserId) fail('IDENTITY_CONFIRMATION_REQUIRED', '首次登录须提供 --expect-user-id，填写目标账号主页 /user/ 后的数字 ID');
  return withAccountLock(opts.account, 'auth_login', async () => {
    if (!readAccountMeta(opts.account)?.userId && !opts.expectUserId) fail('IDENTITY_CONFIRMATION_REQUIRED', '首次绑定必须确认预期数字账号 ID');
    const { context, page } = await launchBrowser({ ...opts, headless: false });
    try {
      if (await openAccountSignIn(page)) {
        await page.getByText(/请使用今日头条\s*App\s*扫码登录/i).first().waitFor({ state: 'visible' });
        const path = join(ensurePrivateDir(getScreenshotDir(opts.account)), `login-${randomUUID()}.png`);
        await page.screenshot({ path });
        chmodSync(path, 0o600);
        process.stderr.write(JSON.stringify({ account: opts.account, status: 'waiting_for_scan', qr_screenshot: path, message: '请在浏览器中人工扫码；验证码/安全验证也需人工完成，等待最多 5 分钟' }) + '\n');
        try {
          await page.waitForURL(url => url.hostname === 'mp.toutiao.com' && url.pathname.startsWith('/profile_v4'), { timeout: 300000 });
        } catch { fail('LOGIN_TIMEOUT', '人工登录超时；未自动刷新、切号或绕过验证'); }
      }
      await page.goto(MP_HOME, { waitUntil: 'domcontentloaded' });
      const identity = await readIdentity(page);
      bindAccount(opts.account, identity, opts.expectUserId);
      return { success: true, account: opts.account, logged_in: true, identity_verified: true, message: '身份已绑定至别名，会话已保存在本地私有目录' };
    } finally { await context.close(); }
  });
}

export async function doLogout(opts) {
  validateAccount(opts.account);
  return withAccountLock(opts.account, 'auth_logout', async () => {
    const dir = getAccountDir(validateAccount(opts.account));
    if (existsSync(dir)) {
      const archive = ensurePrivateDir(join(BASE_DIR, 'archive'));
      renameSync(dir, join(archive, `${opts.account}-${randomUUID()}`));
    }
    return { success: true, account: opts.account, message: '本地会话已归档；平台服务端登录状态未撤销' };
  });
}

export function listAccounts() { return listLocalAccounts(); }
