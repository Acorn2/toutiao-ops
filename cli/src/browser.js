import { chromium } from 'playwright';
import { join } from 'node:path';
import { getAccountDir, prepareAccount, assertLocalPath, ensurePrivateDir } from './account-store.js';

const DEFAULT_VIEWPORT = { width: 1440, height: 900 };

export function getBrowserDataDir(account) {
  return assertLocalPath(join(getAccountDir(account), 'browser-data'));
}

export function getScreenshotDir(account) {
  return assertLocalPath(join(getAccountDir(account), 'screenshots'));
}

export async function launchBrowser(opts = {}) {
  process.umask(0o077);
  prepareAccount(opts.account || 'default');
  const userDataDir = ensurePrivateDir(getBrowserDataDir(opts.account));
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: Boolean(opts.headless),
    viewport: DEFAULT_VIEWPORT,
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    permissions: [],
  });

  // Keep the portal's permissions empty so prompts cannot interfere with the workflow.
  await context.grantPermissions([], { origin: 'https://mp.toutiao.com' }).catch(() => {});
  const page = context.pages()[0] || await context.newPage();
  context.setDefaultTimeout(15000);
  context.setDefaultNavigationTimeout(30000);
  return { context, page };
}
