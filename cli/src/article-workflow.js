import { makeResult, failureResult } from './result.js';
import { fail } from './errors.js';

function verifiedResult(opts, record, expectedId) {
  if (!record || !record.id || !record.url || !record.contentMatches || record.status !== 'draft_saved'
    || (expectedId != null && String(record.id) !== String(expectedId))) return null;
  return makeResult(opts, {
    success: true, verified: true, status: record.status, article_id: record.id, url: record.url,
    message: '已回查草稿记录与正文',
  });
}

// driver encapsulates UI details; tests exercise the same orchestration with controlled drivers.
export async function executeArticle(opts, input, driver, store) {
  if (!opts.draft || opts.publish || opts.confirmPublish || opts.dryRun) fail('ACTION_REQUIRED', '此流程仅支持保存草稿');
  let entry = store.read();
  let mutationPossible = !!entry;
  let stage = 'identity';
  const action = 'draft_save';
  const resultOpts = { ...opts, title: input.title };
  if (entry?.action && entry.action !== action) {
    return makeResult(resultOpts, { status: 'unverified', error_code: 'RECONCILIATION_REQUIRED',
      message: '同一稿件已有其他平台操作记录，请人工核查。' });
  }
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
    const record = await driver.findRecord(input, entry);
    if (record?.ambiguous) fail('DUPLICATE_TITLE', '存在多个同标题记录，无法安全确认；请人工核查，不会新建');
    const verified = verifiedResult(resultOpts, record, entry?.article_id);
    if (verified) {
      store.write({ ...entry, action, state: 'verified', article_id: record.id, result: verified });
      return verified;
    }
    if (opts.reconcileOnly || entry || record) {
      return uncertain('RECONCILIATION_REQUIRED', record?.progressMessage || '发现历史操作或同标题记录，内容/状态尚未确认；已停止重复创建');
    }
    if (!driver.listVerified) fail('LIST_UNAVAILABLE', '无法确认作品/草稿列表已完整加载，停止写操作');
    entry = { action, state: 'editing', request_id: opts.requestId, started_at: new Date().toISOString() };
    store.write(entry);
    mutationPossible = true; // Editors may autosave, even before explicit submission.
    stage = 'editor';
    entry.manifest = await driver.prepare(input, (id, checkpoint) => {
      if (entry.article_id && entry.article_id !== id) fail('DRAFT_ID_MISMATCH', '本次进度对应的草稿 ID 已变化');
      entry.article_id = id;
      entry.checkpoint = checkpoint;
      store.write(entry);
    });
    store.write(entry);
    stage = 'pre_submit';
    await driver.assertIdentity();
    await driver.checkReady(input);
    entry.state = 'submitting';
    store.write(entry); // Record intent before waiting for the editor's final autosave.
    stage = 'submit';
    await driver.submit();
    entry.state = 'unverified';
    store.write(entry);
    stage = 'verify';
    await driver.assertIdentity();
    const persisted = await driver.findRecord(input, entry);
    const result = verifiedResult(resultOpts, persisted, entry.article_id);
    if (result) {
      store.write({ ...entry, state: 'verified', article_id: persisted.id, result });
      return result;
    }
    return uncertain(persisted?.ambiguous ? 'DUPLICATE_TITLE' : 'PERSISTENCE_UNVERIFIED', '操作已尝试，但未确认持久化记录与正文；禁止认定成功或盲目重试');
  } catch (error) {
    const failedAction = driver.editorAction;
    // A failed write can still have reached the platform. Leave the original page
    // in place when its editor is needed for recovery.
    if (mutationPossible && !driver.keepEditorOpen && stage !== 'identity' && stage !== 'reconcile') {
      try {
        await driver.assertIdentity();
        const record = await driver.findRecord(input, entry);
        const verified = verifiedResult(resultOpts, record, entry?.article_id);
        if (verified) {
          store.write({ ...entry, state: 'verified', article_id: record.id, result: verified });
          return verified;
        }
      } catch { /* Keep the uncertain state; no second mutation. */ }
    }
    const diagnostic = await diagnose();
    if (diagnostic && failedAction) diagnostic.failed_action = failedAction;
    const result = failureResult(resultOpts, error, { status: mutationPossible ? 'unverified' : 'failed', stage, diagnostic: diagnostic || null });
    if (mutationPossible) {
      if (failedAction && ['editor', 'pre_submit', 'submit'].includes(stage)) {
        entry.edit_failure = { action: failedAction, error_code: result.error_code,
          ...(driver.rejectedAutosave && { rejected_autosave: driver.rejectedAutosave }) };
        if (result.error_code === 'OPERATION_FAILED') result.message = `编辑步骤 ${failedAction} 失败，请按原任务回查草稿进度。`;
      }
      try { store.write({ ...entry, state: 'unverified', error_code: result.error_code, stage, diagnostic }); }
      catch { result.local_state_error = '本地状态写入失败，请先人工回查后台，不要重复提交'; }
    }
    return result;
  }
}
