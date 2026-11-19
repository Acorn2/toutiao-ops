import { makeResult, failureResult } from './result.js';
import { fail } from './errors.js';

function verifiedResult(opts, record, expectedId) {
  const allowed = opts.draft ? ['draft_saved'] : ['submitted_for_review', 'published'];
  if (!record || !record.id || !record.url || !record.contentMatches || !allowed.includes(record.status)
    || (expectedId != null && String(record.id) !== String(expectedId))) return null;
  return makeResult(opts, {
    success: true, verified: true, status: record.status, article_id: record.id, url: record.url,
    message: record.status === 'submitted_for_review' ? '已回查平台记录：已提交审核，尚未公开' : '已回查平台记录与正文',
  });
}

// driver encapsulates UI details; tests exercise the same orchestration with controlled drivers.
export async function executeArticle(opts, input, driver, store) {
  let entry = store.read();
  let mutationPossible = !!entry;
  let stage = 'identity';
  const action = opts.draft ? 'draft_save' : 'publish';
  const resultOpts = { ...opts, title: input.title };
  const diagnose = async () => {
    try { return await driver.diagnose?.(stage) || null; } catch { return null; }
  };
  const uncertain = async (error_code, message) => {
    const result = makeResult(resultOpts, { status: 'unverified', error_code, message, stage, diagnostic: await diagnose() });
    if (entry) {
      try { store.write({ ...entry, state: 'unverified', error_code, stage, diagnostic: result.diagnostic }); }
      catch { result.local_state_error = '本地状态写入失败，请先人工回查后台，不要重复提交'; }
    }
    return result;
  };
  try {
    await driver.assertIdentity();
    stage = 'reconcile';
    // Query BEFORE any editor mutation, including on first use and after a timeout.
    const record = await driver.findRecord(input, entry, action);
    if (record?.ambiguous) fail('DUPLICATE_TITLE', '存在多个同标题记录，无法安全确认；请人工核查，不会新建');
    const verified = verifiedResult(resultOpts, record, entry?.article_id);
    if (verified) {
      store.write({ ...entry, action, state: 'verified', article_id: record.id, result: verified });
      return verified;
    }
    if (opts.reconcileOnly || entry || record) {
      return uncertain('RECONCILIATION_REQUIRED', '发现历史操作或同标题记录，内容/状态尚未确认；已停止重复创建');
    }
    if (!driver.listVerified) fail('LIST_UNAVAILABLE', '无法确认作品/草稿列表已完整加载，停止写操作');
    entry = { action, state: 'editing', request_id: opts.requestId, started_at: new Date().toISOString() };
    store.write(entry);
    mutationPossible = true; // Editors may autosave, even before explicit submission.
    stage = 'editor';
    entry.manifest = await driver.prepare(input, action);
    store.write(entry);
    stage = 'pre_submit';
    await driver.assertIdentity();
    await driver.checkReady(input);
    entry.state = 'submitting';
    store.write(entry); // Persist intent BEFORE the button click.
    stage = 'submit';
    await driver.submit(action);
    entry.state = 'unverified';
    store.write(entry);
    stage = 'verify';
    await driver.assertIdentity();
    const persisted = await driver.findRecord(input, entry, action);
    const result = verifiedResult(resultOpts, persisted, entry.article_id);
    if (result) {
      store.write({ ...entry, state: 'verified', article_id: persisted.id, result });
      return result;
    }
    return uncertain(persisted?.ambiguous ? 'DUPLICATE_TITLE' : 'PERSISTENCE_UNVERIFIED', '操作已尝试，但未确认持久化记录与正文；禁止认定成功或盲目重试');
  } catch (error) {
    // A failed click can still have reached the platform. Reconcile once, never resubmit.
    if (mutationPossible && stage !== 'identity' && stage !== 'reconcile') {
      try {
        await driver.assertIdentity();
        const record = await driver.findRecord(input, entry, action);
        const verified = verifiedResult(resultOpts, record, entry?.article_id);
        if (verified) {
          store.write({ ...entry, state: 'verified', article_id: record.id, result: verified });
          return verified;
        }
      } catch { /* Keep the uncertain state; no second mutation. */ }
    }
    const diagnostic = await diagnose();
    const result = failureResult(resultOpts, error, { status: mutationPossible ? 'unverified' : 'failed', stage, diagnostic: diagnostic || null });
    if (mutationPossible) {
      try { store.write({ ...entry, state: 'unverified', error_code: result.error_code, stage, diagnostic }); }
      catch { result.local_state_error = '本地状态写入失败，请先人工回查后台，不要重复提交'; }
    }
    return result;
  }
}
