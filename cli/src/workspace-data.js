import { BASE_DIR, egoBindingKey, readAccountMeta, validateAccount } from './account-store.js';
import { withAccountLock } from './account-lock.js';
import { createDraftQueue } from './draft-queue.js';
import { runEgo } from './ego-runtime.js';
import { fail } from './errors.js';
import { failureResult } from './result.js';

function draftRows(rows) {
  const counts = new Map();
  const keyed = rows.map(row => ({ ...row, key: row.id ? `id:${row.id}` : `title:${row.title}` }));
  for (const row of keyed) {
    const keys = [`title:${row.title}`, ...(row.id ? [row.key] : [])];
    for (const key of keys) counts.set(key, (counts.get(key) || 0) + 1);
  }
  return keyed.map(row => ({ ...row, can_open: counts.get(row.key) === 1 }));
}

export function createWorkspaceData({ baseDir = BASE_DIR, browser = runEgo } = {}) {
  const queue = createDraftQueue({ baseDir });
  const snapshots = new Map();
  const requests = new Map();

  function overview() {
    return {
      accounts: queue.snapshot().accounts.map(account => {
        const binding = account.ego_profile_bound && egoBindingKey(readAccountMeta(account.account, baseDir));
        const cached = snapshots.get(account.account);
        const current = binding && cached?.binding === binding ? cached : null;
        return {
          ...account,
          display_name: current?.display_name || account.display_name || null,
          user_id: account.profile_url?.match(/\/user\/(\d+)\/$/)?.[1] || null,
          drafts: current?.drafts || null,
          publications: current?.publications || account.publications || null,
        };
      }),
    };
  }

  function sync(value) {
    const account = validateAccount(value);
    const pending = requests.get(account);
    if (pending) return pending;
    const request = withAccountLock(account, 'workspace_sync', async () => {
      const meta = readAccountMeta(account, baseDir);
      const binding = egoBindingKey(meta);
      if (!binding) fail('EGO_ACCOUNT_UNBOUND', '请先绑定 Ego Profile');
      const previous = overview().accounts.find(group => group.account === account);
      let result;
      try { result = await browser('readWorkspace', { profileId: meta.egoProfileId, expectedUserId: meta.userId }); }
      catch (error) { result = failureResult({}, error); }
      const at = new Date().toISOString();
      snapshots.set(account, {
        binding,
        display_name: result.display_name || previous?.display_name,
        drafts: result.drafts?.rows
          ? { rows: draftRows(result.drafts.rows), synced_at: at, sync_error: null }
          : { ...previous?.drafts, sync_error: result.drafts?.error_code || result.error_code || 'LIST_VIEW_UNVERIFIED' },
        publications: result.publications?.articles
          ? { total: result.publications.total, articles: result.publications.articles, synced_at: at, sync_error: null }
          : { ...previous?.publications, sync_error: result.publications?.error_code || result.error_code || 'PUBLISHED_LIST_UNAVAILABLE' },
      });
      return overview().accounts.find(group => group.account === account);
    }, baseDir).finally(() => requests.delete(account));
    requests.set(account, request);
    return request;
  }

  async function openDraft(value, key) {
    const account = validateAccount(value);
    return withAccountLock(account, 'workspace_open_draft', async () => {
      const meta = readAccountMeta(account, baseDir);
      const binding = egoBindingKey(meta);
      if (!binding) fail('EGO_ACCOUNT_UNBOUND', '请先绑定 Ego Profile');
      const cached = snapshots.get(account);
      const draft = cached?.binding === binding && cached.drafts?.rows?.find(row => row.key === key && row.can_open);
      if (!draft) fail('DRAFT_LIST_CHANGED', '请先重新同步这个账号的草稿');
      const result = await browser('openWorkspaceDraft', { profileId: meta.egoProfileId, expectedUserId: meta.userId,
        draft: { id: draft.id, title: draft.title } });
      if (!result.success) fail(result.error_code || 'EGO_RUNTIME_FAILED', result.message || '无法在 Ego 打开草稿');
      return { success: true };
    }, baseDir);
  }

  return { overview, sync, openDraft };
}
