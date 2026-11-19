import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { getAccountDir, readPrivateJson } from './account-store.js';
import { assertEgoDraftInput, prepareArticle, previewArticle } from './article-input.js';
import { makeResult, failureResult } from './result.js';
import { executeArticle } from './article-workflow.js';
import { fail } from './errors.js';

export async function publishArticle(options) {
  const opts = { ...options, requestId: options.requestId || randomUUID() };
  let browser;
  let store;
  let operationPath;
  try {
    const input = prepareArticle(opts);
    opts.title = input.title;
    if (opts.expectedSignature && input.signature !== opts.expectedSignature) fail('DRAFT_SOURCE_CHANGED', '源稿与登记版本不一致，请重新登记要提交的版本');
    if (opts.dryRun) {
      const result = makeResult(opts, { success: true, status: 'validated', verified: false, message: '本地校验通过；未启动浏览器或访问平台', preview: previewArticle(input) });
      if (opts.previewFile) {
        const { buildPreviewHtml, writePreviewFile } = await import('./article-preview.js');
        result.preview_file = writePreviewFile(opts.previewFile, buildPreviewHtml(input));
      }
      return result;
    }
    if (opts.browser && !['playwright', 'ego'].includes(opts.browser)) fail('BROWSER_UNSUPPORTED', '浏览器参数仅支持 ego 和 playwright');
    if (!opts.draft && opts.browser === 'ego') fail('EGO_DRAFT_ONLY', 'Ego 浏览器入口用于保存草稿');
    if (opts.draft && opts.browser !== 'playwright') {
      if (opts.headless) fail('EGO_HEADLESS_UNSUPPORTED', 'Ego 存稿使用可见的浏览器会话');
      assertEgoDraftInput(input);
      const { runEgo, withEgoLock } = await import('./ego-runtime.js');
      operationPath = join(getAccountDir(opts.account), 'operations', `${input.signature}.json`);
      return await withEgoLock(() => runEgo('saveDraft', { opts, input }));
    }
    // Lazy imports keep dry-run free of browser, profile and platform side effects.
    const { openOperation } = await import('./operation-store.js');
    const { readAccountMeta } = await import('./account-store.js');
    store = openOperation(opts.account, input.signature);
    if (!readAccountMeta(opts.account)?.userId) fail('ACCOUNT_UNBOUND', '账号尚未绑定，请先显式执行 auth login');
    const { launchBrowser } = await import('./browser.js');
    const { ArticlePage } = await import('./article-page.js');
    browser = await launchBrowser(opts);
    const result = await executeArticle(opts, input, new ArticlePage(browser.context, browser.page, opts.account), store);
    return { ...result, warnings: input.warnings };
  } catch (error) {
    let uncertain = false;
    try { uncertain = !!(operationPath ? readPrivateJson(operationPath) : store?.read()); } catch { uncertain = true; }
    return failureResult(opts, error, uncertain ? { status: 'unverified' } : {});
  }
  finally {
    try { await browser?.context.close(); } catch { /* Result already describes platform evidence. */ }
    try { store?.close(); } catch { /* A residual lock blocks future writes conservatively. */ }
  }
}
