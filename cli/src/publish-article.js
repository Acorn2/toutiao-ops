import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { fail } from './errors.js';
import { getAccountDir, readPrivateJson } from './account-store.js';
import { assertEgoDraftInput, prepareArticle, previewArticle } from './article-input.js';
import { makeResult, failureResult } from './result.js';

export async function publishArticle(options) {
  const opts = { ...options, requestId: options.requestId || randomUUID() };
  let operationPath;
  try {
    const input = prepareArticle(opts);
    opts.title = input.title;
    if (opts.expectedSignature && input.signature !== opts.expectedSignature) fail('DRAFT_SOURCE_CHANGED', '源稿与登记版本不一致，请重新登记要提交的版本');
    assertEgoDraftInput(input);
    if (opts.dryRun) {
      const result = makeResult(opts, { success: true, status: 'validated', verified: false, message: '本地校验通过；未启动浏览器或访问平台', preview: previewArticle(input) });
      if (opts.previewFile) {
        const { buildPreviewHtml, writePreviewFile } = await import('./article-preview.js');
        result.preview_file = writePreviewFile(opts.previewFile, buildPreviewHtml(input));
      }
      return result;
    }
    const { runEgo, withEgoLock } = await import('./ego-runtime.js');
    operationPath = join(getAccountDir(opts.account), 'operations', `${input.signature}.json`);
    return await withEgoLock(() => runEgo('saveDraft', { opts, input }));
  } catch (error) {
    let uncertain = false;
    try { uncertain = !!operationPath && !!readPrivateJson(operationPath); } catch { uncertain = true; }
    return failureResult(opts, error, uncertain ? { status: 'unverified' } : {});
  }
}
