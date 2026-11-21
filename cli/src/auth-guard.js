import { fail } from './errors.js';

export const MP_HOME = 'https://mp.toutiao.com/profile_v4/index';
export const IDENTITY_LINK = '.information a[href*="user/"]';

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

export function verifyIdentity(identity, meta) {
  if (!meta?.userId) fail('ACCOUNT_UNBOUND', '别名尚未绑定稳定身份，请先执行 auth bind-ego');
  if (!identity?.userId || identity.userId !== meta.userId) fail('ACCOUNT_MISMATCH', '当前账号与别名绑定不一致，停止写操作');
}
