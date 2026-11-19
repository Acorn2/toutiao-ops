import { readAccountMeta } from './account-store.js';
import { fail } from './errors.js';

export const MP_HOME = 'https://mp.toutiao.com/profile_v4/index';
export const IDENTITY_LINK = '.information a[href*="user/"]';
const MP_LOGIN = 'https://mp.toutiao.com/auth/page/login';

function isLoginUrl(url) {
  return url.protocol === 'https:' && (
    url.hostname === 'sso.toutiao.com' ||
    (url.hostname === 'mp.toutiao.com' && (/\/auth\/|login/.test(url.pathname)))
  );
}

async function waitForIdentityOrLogin(page) {
  try {
    await Promise.any([
      page.locator(IDENTITY_LINK).first().waitFor({ state: 'attached', timeout: 15000 }),
      page.waitForURL(isLoginUrl, { timeout: 15000 }),
    ]);
  } catch { fail('AUTH_STATE_UNAVAILABLE', '未观察到登录页或稳定账号身份，请人工检查后台页面'); }
}

export async function openAccountSignIn(page) {
  const response = await page.goto(MP_HOME, { waitUntil: 'domcontentloaded' });
  try {
    await waitForIdentityOrLogin(page);
  } catch (error) {
    // Signed-out dashboard visits can show a 200 app shell without redirecting.
    if (error.code !== 'AUTH_STATE_UNAVAILABLE' || !response?.ok() || page.url() !== MP_HOME) throw error;
    await page.goto(MP_LOGIN, { waitUntil: 'domcontentloaded' });
    await waitForIdentityOrLogin(page);
  }
  return isLoginUrl(new URL(page.url()));
}

// Serialized into the browser by both the Playwright and Ego adapters.
export function inspectIdentityLink(selector) {
  const links = document.querySelectorAll(selector);
  if (links.length !== 1) return null;
  const link = links[0];
  try {
    const url = new URL(link.href);
    const userId = url.pathname.match(/^\/(?:c\/)?user\/(\d+)\/?$/)?.[1];
    if (!userId || url.username || url.password || !['https://www.toutiao.com', 'https://toutiao.com'].includes(url.origin)) return null;
    const name = link.closest('.information')?.querySelector('.auth-avator-name')?.textContent || link.textContent;
    return { userId, username: name.trim().slice(0, 80) };
  } catch { return null; }
}

export async function readIdentity(page) {
  const current = new URL(page.url());
  if (current.origin !== new URL(MP_HOME).origin || /\/auth\/|login/.test(current.pathname)) fail('AUTH_REQUIRED', '登录已失效，请显式执行 auth login 人工扫码');
  try {
    await page.locator(IDENTITY_LINK).first().waitFor({ state: 'attached', timeout: 15000 });
  } catch {
    if (/\/auth\/|login/.test(new URL(page.url()).pathname)) fail('AUTH_REQUIRED', '登录已过期，请人工扫码');
    fail('IDENTITY_UNAVAILABLE', '未找到稳定的账号主页 ID，停止操作；需人工检查页面');
  }
  const identity = await page.evaluate(inspectIdentityLink, IDENTITY_LINK);
  if (!identity) fail('IDENTITY_UNAVAILABLE', '无法识别唯一可信的账号 ID，停止操作');
  return identity;
}

export async function ensureLoggedIn(page) {
  await page.goto(MP_HOME, { waitUntil: 'domcontentloaded' });
  await waitForIdentityOrLogin(page);
  return readIdentity(page);
}

export function verifyIdentity(identity, meta) {
  if (!meta?.userId) fail('ACCOUNT_UNBOUND', '别名尚未绑定稳定身份，请先显式执行 auth login');
  if (!identity?.userId || identity.userId !== meta.userId) fail('ACCOUNT_MISMATCH', '当前账号与别名绑定不一致，停止写操作');
}

export async function assertBoundIdentity(context, account) {
  const meta = readAccountMeta(account);
  if (!meta?.userId) fail('ACCOUNT_UNBOUND', '别名尚未绑定稳定身份，请先显式执行 auth login');
  const checkPage = await context.newPage();
  try { verifyIdentity(await ensureLoggedIn(checkPage), meta); }
  finally { await checkPage.close(); }
}
