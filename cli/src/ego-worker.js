import { randomUUID } from 'node:crypto';
import { executeArticle } from './article-workflow.js';
import { EgoDraftPage, verifyEgoIdentity } from './ego-draft-page.js';
import { egoBindingKey, isEgoProfileId, readAccountMeta } from './account-store.js';
import { openOperation } from './operation-store.js';
import { failureResult } from './result.js';
import { fail } from './errors.js';
import { readEgoPublications } from './ego-published.js';

async function openTask(sdk, profileId) {
  if (!isEgoProfileId(profileId)) fail('EGO_PROFILE_REQUIRED', 'Ego 操作须指定有效的独立 Profile ID');
  return sdk.taskSpace(`toutiao-${randomUUID()}`, { profileId });
}

async function endTask(task, result) {
  if (!task) return;
  try {
    if (result?.error_code === 'MANUAL_VERIFICATION_REQUIRED') await task.handOff();
    else if (!['user', 'inactive', 'unassigned'].includes(task.ownership)) await task.finish({ keep: [] });
  } catch { /* The browser result is already recorded. */ }
}

export async function checkProfile(sdk, { profileId, expectedUserId, resolveProfile }) {
  let task;
  let result;
  try {
    if (resolveProfile) {
      const choices = await sdk.profiles();
      const available = Array.isArray(choices) ? choices : choices?.profiles;
      const matching = Array.isArray(available) ? available.map(profile => isEgoProfileId(profile) ? profile : profile?.id ?? profile?.profileId)
        .filter(id => isEgoProfileId(id) && String(id) === String(profileId)) : [];
      if (matching.length !== 1) fail('EGO_PROFILE_UNAVAILABLE', 'Ego Lite 未找到唯一匹配的 Profile');
      [profileId] = matching;
    }
    task = await openTask(sdk, profileId);
    const identity = await verifyEgoIdentity(task.page('p1'), expectedUserId);
    result = { success: true, profile_id: profileId, display_name: identity?.username };
  } catch (error) { result = failureResult({}, error); }
  finally { await endTask(task, result); }
  return result;
}

export async function listPublications(sdk, { profileId, expectedUserId }) {
  let task;
  let result;
  try {
    task = await openTask(sdk, profileId);
    const data = await readEgoPublications(task.page('p1'), expectedUserId);
    result = { success: !data.error_code, ...data };
  } catch (error) { result = failureResult({}, error); }
  finally { await endTask(task, result); }
  return result;
}

export async function saveDraft(sdk, { opts, input }) {
  let task;
  let store;
  let result;
  try {
    store = openOperation(opts.account, input.signature);
    const meta = readAccountMeta(opts.account);
    if (!meta?.userId || !isEgoProfileId(meta.egoProfileId)) fail('EGO_ACCOUNT_UNBOUND', '请先用 auth bind-ego 将该别名绑定到指定 Ego Profile');
    if (opts.expectedBinding && egoBindingKey(meta) !== opts.expectedBinding) fail('DRAFT_BINDING_CHANGED', '账号绑定和登记时不一致，初始化浏览器前已停止');
    task = await openTask(sdk, meta.egoProfileId);
    result = await executeArticle(opts, input, new EgoDraftPage(task, meta.userId), store);
  } catch (error) {
    let uncertain = false;
    try { uncertain = !!store?.read(); } catch { uncertain = true; }
    result = failureResult(opts, error, uncertain ? { status: 'unverified' } : {});
  }
  finally {
    try { await endTask(task, result); }
    finally { store?.close(); }
  }
  return { ...result, browser: 'ego', warnings: input.warnings };
}
