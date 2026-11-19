import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { escapeHtml as esc } from './article-input.js';
import { publishedArticleUrl } from './ego-published.js';

const STYLE = readFileSync(new URL('./draft-overview.css', import.meta.url), 'utf8');
const SCRIPT = readFileSync(new URL('./draft-overview-client.js', import.meta.url), 'utf8').replace(/\r\n?/g, '\n');
const SCRIPT_HASH = createHash('sha256').update(SCRIPT).digest('base64');
const LABEL = { pending: '待存稿', running: '存稿中', verified: '草稿已核对', blocked: '待处理', unverified: '待回查' };
const PRIORITY = ['unverified', 'blocked', 'running', 'pending', 'verified'];
const DRAFT_LINK = /^https:\/\/mp\.toutiao\.com\/profile_v4\/graphic\/publish\?pgc_id=\d+$/;
const PROFILE_LINK = /^https:\/\/www\.toutiao\.com\/c\/user\/\d+\/$/;
const TIME = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

function timeTag(value) {
  const time = new Date(value);
  return value && Number.isFinite(time.getTime())
    ? `<time datetime="${esc(time.toISOString())}">${esc(TIME.format(time))}</time>`
    : '';
}

function accountName(group) {
  return typeof group.display_name === 'string' && group.display_name.trim() || group.account;
}

function monogram(group, index) {
  const initials = group.display_name ? Array.from(accountName(group))[0] : '号';
  return `<span class="monogram tone-${index % 3}" aria-hidden="true">${esc(initials)}</span>`;
}

function draftRow(task) {
  const confirmed = task.verified && DRAFT_LINK.test(task.draft_url || '');
  const note = task.draft_found && !task.verified ? '已找到草稿，全文核对未通过' : '';
  const status = PRIORITY.includes(task.status) ? task.status : 'blocked';
  return `<li id="task-${esc(task.id)}" class="record draft-row" data-status="${status}" data-title="${esc(task.title)}"
    data-search="${esc([task.title,task.source_name,task.id].join(' '))}" data-time="${esc(task.updated_at)}">
    <div class="record-body"><h4>${esc(task.title)}</h4>
      ${note ? `<p class="issue">${esc(note)}</p>` : ''}
      ${task.message ? `<p class="subtext">${esc(task.message)}</p>` : ''}
      ${task.next ? `<p class="subtext">${esc(task.next)}</p>` : ''}
      ${!confirmed ? `<details class="task-info"><summary>任务信息</summary><p>${esc(task.source_name)} <code>${esc(task.version)}</code></p><p><code>${esc(task.id)}</code></p></details>` : ''}</div>
    <div class="record-meta"><span class="status ${status}">${LABEL[status]}</span>${timeTag(task.updated_at)}</div>
    ${confirmed ? `<a class="record-action" href="${esc(task.draft_url)}" target="_blank" rel="noopener noreferrer">打开草稿 <span aria-hidden="true">↗</span></a>` : ''}
  </li>`;
}

function articleRow(article) {
  const url = publishedArticleUrl(article.url);
  return `<li class="record article-row" data-title="${esc(article.title)}" data-search="${esc([article.title,article.date].join(' '))}">
    <div class="record-body"><h4>${esc(article.title)}</h4></div><span class="record-meta">${esc(article.date || '—')}</span>
    ${url ? `<a class="record-action" href="${esc(url)}" target="_blank" rel="noopener noreferrer" aria-label="${esc(`查看原文 ${article.title}`)}">查看原文 <span aria-hidden="true">↗</span></a>` : ''}
  </li>`;
}

function recordList({ kind, label, entries, empty, note = '' }) {
  const draft = kind === 'drafts';
  return `<section class="content-list" data-kind="${kind}" data-empty="${esc(empty)}" aria-label="${label}" hidden>
    ${note}
    <form class="list-toolbar" role="search" aria-label="查找${label}">
      <label class="search-field"><span>搜索${label}</span><input type="search" name="query" placeholder="${draft ? '按标题、来源文件或任务号' : '按标题或发布时间'}" autocomplete="off"></label>
      ${draft ? `<label><span>状态</span><select name="status" aria-label="草稿状态"><option value="">全部状态</option>
        <option value="attention">需要处理</option>${PRIORITY.map(status => `<option value="${status}">${LABEL[status]}</option>`).join('')}</select></label>` : ''}
      <label><span>排序</span><select name="sort" aria-label="排序">${draft ? '<option value="priority">异常优先</option>' : ''}
        <option value="latest">${draft ? '最近更新' : '最近发布'}</option><option value="oldest">${draft ? '最早更新' : '最早发布'}</option><option value="title">按标题</option></select></label>
      <button class="reset" type="reset">重置</button>
    </form>
    <div class="list-summary"><p class="list-range" role="status"></p>
    <nav class="pagination" aria-label="${label}分页">
      <label><span>每页</span> <select class="page-size" aria-label="每页条数"><option>10</option><option>20</option><option>50</option></select></label>
      <div class="page-nav"><button type="button" data-step="-1">上一页</button>
        <form class="jump"><label><span>页码</span> <input name="page" type="number" min="1" value="1" required></label><span class="page-total"></span><button type="submit">跳转</button></form>
        <button type="button" data-step="1">下一页</button></div>
    </nav></div>
    <ul class="records" aria-label="${label}列表"></ul>
    <p class="empty-copy" hidden></p>
    <template>${entries}</template>
  </section>`;
}

function publicationSection(publications) {
  const known = Number.isSafeInteger(publications?.total) && publications.total >= 0;
  const articles = Array.isArray(publications?.articles) ? publications.articles : [];
  const syncText = publications?.sync_error ? (known ? '本次同步失败，以下是上次快照。' : '读取失败，请检查 Ego 登录后重新同步。') : '';
  const partial = known && publications.total > articles.length;
  return recordList({ kind: 'published', label: '已发布文章', entries: articles.map(articleRow).join(''),
    empty: known && publications.total === 0 ? '暂无已发布文章' : '本地暂无文章明细，运行 drafts open --sync 同步。',
    note: `${syncText ? `<p class="issue">${syncText}</p>` : ''}
      ${known && publications.synced_at ? `<p class="section-note">作品同步于 ${timeTag(publications.synced_at)}${partial ? ` · 本地有 ${articles.length} / ${publications.total} 篇，运行 <code>drafts open --sync</code> 补齐` : ''}</p>` : ''}` });
}

function profileLink(group) {
  return PROFILE_LINK.test(group.profile_url || '') ? `<a class="profile-link" href="${esc(group.profile_url)}" target="_blank" rel="noopener noreferrer">账号主页 <span aria-hidden="true">↗</span></a>` : '';
}

function accountSection(group, index) {
  const tasks = group.tasks.slice().sort((a, b) => PRIORITY.indexOf(a.status) - PRIORITY.indexOf(b.status) || b.updated_at.localeCompare(a.updated_at));
  const known = Number.isSafeInteger(group.publications?.total) && group.publications.total >= 0;
  return `<section class="account" id="account-${esc(group.account)}" aria-labelledby="heading-${index}" hidden>
    <header class="account-heading">${monogram(group, index)}<div>
      <h2 id="heading-${index}">${esc(accountName(group))}</h2>
      <p class="alias">${group.display_name ? `${esc(group.account)} · ` : ''}${group.ego_profile_bound ? 'Ego 已绑定' : 'Ego 未绑定'}</p>
    </div>${profileLink(group)}</header>
    <div class="views" role="group" aria-label="内容类型">
      <button type="button" data-view="drafts" aria-pressed="false">草稿队列 <span class="number">${tasks.length}</span></button>
      <button type="button" data-view="published" aria-pressed="false">已发布文章 ${known ? `<span class="number">${group.publications.total}</span>` : ''}</button>
    </div>
    ${recordList({ kind: 'drafts', label: '草稿队列', entries: tasks.map(draftRow).join(''), empty: '暂无队列稿件' })}
    ${publicationSection(group.publications)}
  </section>`;
}

export function renderDraftOverview(data) {
  const groups = data.accounts.map((group, index) => ({ group, index }));
  const active = groups.filter(({ group }) => group.ego_profile_bound || group.tasks.length);
  const other = groups.filter(({ group }) => !group.ego_profile_bound && !group.tasks.length);
  const issues = active.flatMap(({ group }) => group.tasks.filter(task => task.needs_attention).map(task => ({ task, group })));
  const bound = groups.filter(({ group }) => group.ego_profile_bound).length;
  const metrics = [['已接入账号', bound], ['待存稿', data.counts.pending], ['草稿已核对', data.counts.verified], ['需要处理', data.counts.needs_attention]];
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'sha256-${SCRIPT_HASH}'; base-uri 'none'; form-action 'none'">
<title>头条号发稿总览</title><style>${STYLE}</style></head><body>
<header class="masthead"><div class="container masthead-inner">
  <div class="brand"><span class="brand-mark" aria-hidden="true">头</span><h1>头条号发稿总览</h1></div>
  <p class="snapshot-time">快照 ${timeTag(data.generated_at)}</p>
</div></header>
<main class="container workspace">
  <aside class="rail" aria-label="账号总览">
    <h2>我的账号 <span class="number">${groups.length}</span></h2>
    ${active.length ? `<nav class="accounts-nav" aria-label="账号跳转">${active.map(({ group, index }) =>
      `<a href="#account-${esc(group.account)}">${monogram(group, index)}<span><strong>${esc(accountName(group))}</strong><small><span>草稿 ${group.tasks.length}</span>${Number.isSafeInteger(group.publications?.total) ? `<span>已发布 ${group.publications.total}</span>` : ''}</small></span><span class="chevron" aria-hidden="true">›</span></a>`).join('')}</nav>` : ''}
    ${other.length ? `<details class="other-accounts"><summary>未接入 Ego ${other.length} 个</summary><ul>${other.map(({ group }) =>
      `<li><strong>${esc(accountName(group))}</strong>${group.display_name ? `<small>${esc(group.account)}</small>` : ''}${group.account_error ? '<small>绑定待检查</small>' : ''}${profileLink(group)}</li>`).join('')}</ul></details>` : ''}
  </aside>
  <div class="main-content">
    <dl class="metrics" aria-label="队列概况">${metrics.map(([label, count]) => `<div><dt>${label}</dt><dd>${count}</dd></div>`).join('')}</dl>
    ${issues.length ? `<details class="attention"><summary>需要处理 ${issues.length} 条</summary><ul>${issues.map(({task,group}) =>
      `<li><a href="#task-${esc(task.id)}"><strong>${esc(task.title)}</strong><small>${esc(accountName(group))} · ${esc(LABEL[task.status] || '待处理')}</small></a></li>`).join('')}</ul></details>` : ''}
    ${active.length ? active.map(({group,index})=>accountSection(group,index)).join('') :
      '<section class="empty"><h2>暂无接入的账号</h2><p>绑定头条号后，队列稿件和已发布文章会显示在这里。</p></section>'}
  </div>
</main><noscript><p class="container">此本地页面需要浏览器启用 JavaScript 来显示筛选和分页。</p></noscript><script>${SCRIPT}</script></body></html>`;
}
