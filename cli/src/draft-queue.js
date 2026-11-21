import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { basename, isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';
import { acquireAccountLock, withAccountLock } from './account-lock.js';
import { BASE_DIR, PRIVATE_JSON_LIMIT, assertLocalPath, egoBindingKey, ensurePrivateDir, listAccounts, readAccountMeta, readPrivateJson, validateAccount, writePrivateJson, writePrivateText } from './account-store.js';
import { assertEgoDraftInput, prepareArticle } from './article-input.js';
import { recordId } from './article-records.js';
import { publishArticle } from './publish-article.js';
import { failureResult, redact } from './result.js';
import { fail, OperationError } from './errors.js';
import { renderDraftOverview } from './draft-overview.js';
import { runEgo } from './ego-runtime.js';

const JOB_ID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const STAGES = ['pending', 'running', 'verified', 'blocked', 'unverified'];
const runSystemCommand = promisify(execFile);
const RECOVERY = {
  AUTH_REQUIRED: '在该账号的 Ego Profile 中重新登录，再按任务编号处理。',
  IDENTITY_UNAVAILABLE: '检查该 Ego Profile 的头条登录状态，再按任务编号处理。',
  EGO_PROFILE_UNAVAILABLE: '检查独立 Ego Profile 是否仍可用。',
  EGO_ACCOUNT_UNBOUND: '为该账号恢复 Ego 绑定，再按任务编号处理。',
  DRAFT_BINDING_CHANGED: '核对账号别名及 Ego Profile，恢复原绑定后再处理。',
  ACCOUNT_MISMATCH: '检查 Ego Profile 当前登录的头条号是否与登记账号一致。',
  MANUAL_VERIFICATION_REQUIRED: '在该账号的浏览器中完成安全验证，再按任务编号处理。',
  DRAFT_SOURCE_CHANGED: '恢复登记时的稿件版本，或把修改后的稿件重新登记。',
  INVALID_CONTENT_FILE: '检查源文件是否仍在原路径，恢复后按任务编号处理。',
  EGO_NOT_INSTALLED: '打开已安装的 Ego Lite，并确认终端可调用 ego-browser。',
  ACCOUNT_BUSY: '等待账号或 Ego 剪贴板操作结束，再按任务编号处理。',
  DRAFT_RUN_INTERRUPTED: '按任务编号回查草稿箱，确认是否已经保存。',
};

function draftUrl(result) {
  try {
    const url = new URL(result.url);
    const id = recordId(url);
    if (url.origin === 'https://mp.toutiao.com' && !url.username && !url.password
      && url.pathname === '/profile_v4/graphic/publish' && id && id === String(result.article_id)) {
      return `${url.origin}${url.pathname}?pgc_id=${id}`;
    }
  } catch { /* Invalid platform URL. */ }
  return null;
}

function summarizeResult(result, job, reconcileOnly) {
  const url = draftUrl(result);
  if (result.action === 'draft_save' && result.account === job.account && result.success === true
    && result.status === 'draft_saved' && result.verified === true && url) {
    return { status: 'verified', result: { verified: true, url, article_id: String(result.article_id) } };
  }
  const unverified = reconcileOnly || result.status !== 'failed';
  const error_code = /^[A-Z][A-Z0-9_]+$/.test(result.error_code || '') ? result.error_code : 'DRAFT_RESULT_UNVERIFIED';
  return { status: unverified ? 'unverified' : 'blocked', result: { verified: false, error_code,
    message: redact(String(result.message || '').slice(0, 500)), found: result.diagnostic?.lookup?.found === true } };
}

function projectJob(job, binding) {
  const unmatched = binding !== job.binding;
  const preserveUncertainty = ['running', 'unverified'].includes(job.status);
  const status = unmatched && !preserveUncertainty ? 'blocked' : job.status;
  const code = unmatched ? (binding ? 'DRAFT_BINDING_CHANGED' : 'EGO_ACCOUNT_UNBOUND') : job.result?.error_code;
  const needsAttention = unmatched || status === 'blocked' || status === 'unverified';
  const next = needsAttention ? RECOVERY[code] || (preserveUncertainty
    ? '按任务编号回查草稿箱。已有草稿时检查标题和完整正文。'
    : '查看错误原因，处理后按任务编号重试。') : null;
  return { id: job.id, account: job.account, title: job.title, source_name: basename(job.contentFile), version: job.signature.slice(0, 8),
    status, needs_attention: needsAttention, updated_at: job.updatedAt, verified: status === 'verified',
    draft_url: status === 'verified' ? draftUrl(job.result) : null, draft_found: job.result?.found === true,
    error_code: code || null, message: unmatched ? null : job.result?.message || null, next };
}

async function openInDefaultBrowser(file) {
  // Resolve the HTTPS handler, which can differ from the user's HTML file association.
  const script = `ObjC.import('AppKit');
const url = $.NSURL.URLWithString('https://example.invalid/');
ObjC.unwrap($.NSWorkspace.sharedWorkspace.URLForApplicationToOpenURL(url).path);`;
  const { stdout } = await runSystemCommand('/usr/bin/osascript', ['-l', 'JavaScript', '-e', script]);
  const browser = stdout.trim();
  if (!isAbsolute(browser) || !browser.endsWith('.app')) throw new Error('Default browser unavailable');
  await runSystemCommand('/usr/bin/open', ['-a', browser, file]);
}

export function createDraftQueue({ baseDir = BASE_DIR, publish = publishArticle, openBrowser = openInDefaultBrowser,
  readPublications = payload => runEgo('listPublications', payload) } = {}) {
  const queueDir = join(baseDir, 'draft-queue');
  const jobsDir = join(queueDir, 'jobs');
  const overviewFile = join(queueDir, 'overview.html');
  const publicationsDir = join(queueDir, 'publications');
  const publicationFile = alias => join(assertLocalPath(publicationsDir), `${validateAccount(alias)}.json`);
  const saveJob = job => writePrivateJson(join(jobsDir, `${job.id}.json`), job);

  function readJobs() {
    for (const path of [baseDir, queueDir, jobsDir]) assertLocalPath(path);
    if (!existsSync(jobsDir)) return [];
    return readdirSync(jobsDir).filter(file => file.endsWith('.json') && JOB_ID.test(file.slice(0, -5))).map(file => {
      const job = readPrivateJson(join(jobsDir, file));
      if (!job || job.schemaVersion !== 1 || `${job.id}.json` !== file || !STAGES.includes(job.status)
        || !/^[a-f0-9]{64}$/.test(job.signature || '') || !/^[a-f0-9]{64}$/.test(job.binding || '')
        || typeof job.contentFile !== 'string' || !isAbsolute(job.contentFile) || typeof job.title !== 'string' || typeof job.createdAt !== 'string'
        || !['markdown', 'text'].includes(job.format) || (job.status === 'verified' && (!job.result?.verified || !draftUrl(job.result)))) {
        fail('DRAFT_QUEUE_RECORD_INVALID', '发稿队列存在无效任务记录');
      }
      validateAccount(job.account);
      return job;
    }).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  }

  function snapshot() {
    const accounts = new Map(listAccounts(baseDir).accounts.map(record => {
      const meta = record.usable ? readAccountMeta(record.account, baseDir) : null;
      const binding = egoBindingKey(meta);
      let publications;
      try {
        const cached = binding && readPrivateJson(publicationFile(record.account));
        if (cached?.binding === binding) publications = cached;
      } catch { publications = { sync_error: 'LOCAL_STATE_INVALID' }; }
      return [record.account, {
        account: record.account, display_name: publications?.display_name || meta?.username || null,
        profile_url: /^\d+$/.test(meta?.userId || '') ? `https://www.toutiao.com/c/user/${meta.userId}/` : null,
        ego_profile_bound: !!binding, account_error: record.error_code || null, tasks: [],
        publications: publications ? { total: publications.total ?? null, articles: publications.articles || [],
          synced_at: publications.synced_at || null, sync_error: publications.sync_error || null } : null,
      }];
    }));
    const running = existsSync(join(queueDir, 'locks', 'queue.lock'));
    const counts = { pending: 0, running: 0, verified: 0, needs_attention: 0 };
    for (const job of readJobs()) {
      if (!accounts.has(job.account)) accounts.set(job.account, { account: job.account, ego_profile_bound: false, account_error: null, tasks: [] });
      const group = accounts.get(job.account);
      const state = job.status === 'running' && !running
        ? { ...job, status: 'unverified', result: { error_code: 'DRAFT_RUN_INTERRUPTED' } } : job;
      const task = projectJob(state, group.ego_profile_bound ? egoBindingKey(readAccountMeta(job.account, baseDir)) : null);
      group.tasks.push(task);
      if (task.needs_attention) counts.needs_attention++;
      else counts[task.status]++;
    }
    return { success: true, action: 'draft_overview', generated_at: new Date().toISOString(), counts,
      accounts: [...accounts.values()].sort((a, b) => a.account.localeCompare(b.account)) };
  }

  function overview() {
    const data = snapshot();
    try {
      ensurePrivateDir(baseDir);
      ensurePrivateDir(queueDir);
      writePrivateText(overviewFile, renderDraftOverview(data));
      return { ...data, overview_file: overviewFile };
    } catch { return { ...data, overview_error: '总览 HTML 写入失败，可以继续查看 JSON 状态' }; }
  }

  async function withQueueLock(run) {
    assertLocalPath(baseDir);
    let release;
    try { release = acquireAccountLock('queue', 'draft_queue', queueDir); }
    catch (error) {
      if (error.code === 'ACCOUNT_BUSY') fail('DRAFT_QUEUE_BUSY', '发稿队列正在处理任务，或有残留锁待核查');
      throw error;
    }
    try { return await run(); }
    finally { release(); }
  }

  return {
    overview,
    snapshot,
    async open({ sync = false } = {}) {
      const syncFailures = [];
      if (sync) {
        assertLocalPath(queueDir);
        const accounts = listAccounts(baseDir).accounts.filter(record => record.ego_profile_bound);
        for (const { account } of accounts) {
          try { await withAccountLock(account, 'read_publications', async () => {
            const meta = readAccountMeta(account, baseDir);
            const binding = egoBindingKey(meta);
            if (!binding) return;
            const file = publicationFile(account);
            const cached = readPrivateJson(file);
            const previous = cached?.binding === binding ? cached : {};
            let result;
            try { result = await readPublications({ profileId: meta.egoProfileId, expectedUserId: meta.userId }); }
            catch (error) { result = failureResult({}, error); }
            const update = result.success
              ? { total: result.total, articles: result.articles, synced_at: new Date().toISOString(), sync_error: null }
              : { sync_error: result.error_code || 'PUBLISHED_LIST_UNAVAILABLE' };
            const identity = { binding, display_name: result.display_name || previous.display_name };
            const serialized = JSON.stringify({ ...previous, ...identity, ...update });
            if (Buffer.byteLength(serialized) > PRIVATE_JSON_LIMIT) {
              const error_code = 'PUBLISHED_SNAPSHOT_TOO_LARGE';
              writePrivateText(file, JSON.stringify({ ...previous, ...identity, sync_error: error_code }));
              syncFailures.push({ account, error_code });
            } else {
              writePrivateText(file, serialized);
              if (update.sync_error) syncFailures.push({ account, error_code: update.sync_error });
            }
          }, baseDir); }
          catch (error) {
            syncFailures.push({ account, error_code: error.code || 'PUBLISHED_LIST_UNAVAILABLE' });
          }
        }
      }
      const result = { ...overview(), action: 'draft_overview_open', opened: false, ...(sync ? { sync_failures: syncFailures } : {}) };
      if (!result.overview_file) {
        return { ...result, success: false, error_code: 'DRAFT_OVERVIEW_WRITE_FAILED', message: result.overview_error };
      }
      try {
        await openBrowser(result.overview_file);
        return { ...result, opened: true };
      } catch {
        return { ...result, success: false, error_code: 'DRAFT_OVERVIEW_OPEN_FAILED', message: '总览已刷新，可以用 overview_file 手动打开' };
      }
    },
    async add(opts) {
      const account = validateAccount(opts.account);
      const input = prepareArticle({ account, title: opts.title, contentFile: opts.contentFile, format: opts.format, draft: true });
      assertEgoDraftInput(input);
      return withQueueLock(() => {
        const binding = egoBindingKey(readAccountMeta(account, baseDir));
        if (!binding) fail('EGO_ACCOUNT_UNBOUND', '请先用 auth bind-ego 绑定该账号');
        let job = readJobs().find(entry => entry.account === account && entry.binding === binding && entry.signature === input.signature);
        const already_queued = !!job;
        if (!job) {
          const now = new Date().toISOString();
          job = { schemaVersion: 1, id: randomUUID(), account, title: input.title, titleOverride: opts.title,
            contentFile: input.sourcePath, format: opts.format || 'markdown', signature: input.signature, binding, status: 'pending', createdAt: now, updatedAt: now };
          saveJob(job);
        }
        const { overview_file, overview_error } = overview();
        return { success: true, action: 'draft_queue_add', already_queued, task: projectJob(job, binding), overview_file, overview_error };
      });
    },

    async run(opts) {
      const account = validateAccount(opts.account);
      if (opts.id && !JOB_ID.test(opts.id)) fail('DRAFT_JOB_INVALID', '请使用总览中显示的完整任务编号');
      return withQueueLock(async () => {
        const jobs = readJobs().filter(job => job.account === account && (opts.id ? job.id === opts.id : job.status === 'pending'));
        if (opts.id && !jobs.length) fail('DRAFT_JOB_NOT_FOUND', '指定账号没有这条发稿任务');
        const tasks = [];
        for (const job of jobs) {
          const binding = egoBindingKey(readAccountMeta(account, baseDir));
          const reconcileOnly = ['running', 'unverified', 'verified'].includes(job.status);
          const execution = { account, title: job.titleOverride, contentFile: job.contentFile, format: job.format,
            draft: true, browser: 'ego', expectedSignature: job.signature, expectedBinding: job.binding, reconcileOnly };
          let result;
          if (job.binding !== binding) {
            const error = new OperationError(binding ? 'DRAFT_BINDING_CHANGED' : 'EGO_ACCOUNT_UNBOUND', '当前账号绑定无法匹配登记时的目标');
            result = failureResult(execution, error);
          } else {
            saveJob({ ...job, status: 'running', updatedAt: new Date().toISOString() });
            overview();
            try { result = await publish(execution); }
            catch (error) { result = failureResult(execution, error, { status: 'unverified' }); }
          }
          const finished = { ...job, ...summarizeResult(result, job, reconcileOnly), updatedAt: new Date().toISOString() };
          try { saveJob(finished); }
          catch {
            tasks.push(projectJob({ ...job, status: 'unverified', result: { error_code: 'DRAFT_QUEUE_WRITE_FAILED', message: '无法记录本次结果，按任务编号回查。' } }, binding));
            break;
          }
          tasks.push(projectJob(finished, binding));
          if (finished.status !== 'verified') break;
        }
        const status = tasks.some(task => task.status === 'unverified') ? 'unverified' : tasks.some(task => task.status === 'blocked') ? 'failed' : 'completed';
        const { overview_file, overview_error } = overview();
        return { success: status === 'completed', action: 'draft_queue_run', account, status, tasks, overview_file, overview_error };
      });
    },
  };
}
