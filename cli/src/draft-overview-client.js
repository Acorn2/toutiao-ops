'use strict';

const titleOrder = new Intl.Collator('zh-CN', { numeric: true });
const normalize = value => value.normalize('NFKC').toLocaleLowerCase('zh-CN');
const panels = [...document.querySelectorAll('section.account')];
const links = [...document.querySelectorAll('.accounts-nav a')];
const tasks = new Map();

function connectList(list) {
  const form = list.querySelector('.list-toolbar');
  const { query, status, sort } = form.elements;
  const source = [...list.querySelector('template').content.children];
  const records = source.map(row => ({ row, search: normalize(row.dataset.search || '') }));
  const output = list.querySelector('.records');
  const range = list.querySelector('.list-range');
  const empty = list.querySelector('.empty-copy');
  const pagination = list.querySelector('.pagination');
  const size = list.querySelector('.page-size');
  const jump = list.querySelector('.jump');
  const previous = pagination.querySelector('[data-step="-1"]');
  const next = pagination.querySelector('[data-step="1"]');
  const pageTotal = pagination.querySelector('.page-total');
  const isDraft = list.dataset.kind === 'drafts';
  let page = 1;
  form.hidden = !records.length;

  function render() {
    const words = normalize(query.value).trim().split(/\s+/).filter(Boolean);
    const selected = status?.value;
    const matched = records.filter(({ row, search }) => words.every(word => search.includes(word)) &&
      (!selected || (selected === 'attention' ? ['blocked', 'unverified'].includes(row.dataset.status) : row.dataset.status === selected)));
    if (sort.value === 'title') matched.sort((a, b) => titleOrder.compare(a.row.dataset.title, b.row.dataset.title));
    else if (isDraft && sort.value !== 'priority') {
      const direction = sort.value === 'latest' ? -1 : 1;
      matched.sort((a, b) => direction * a.row.dataset.time.localeCompare(b.row.dataset.time));
    } else if (sort.value === 'oldest') matched.reverse();

    const pageSize = Number(size.value);
    const pageCount = Math.max(1, Math.ceil(matched.length / pageSize));
    page = Math.max(1, Math.min(page, pageCount));
    const start = (page - 1) * pageSize;
    const end = Math.min(start + pageSize, matched.length);
    output.replaceChildren(...matched.slice(start, end).map(item => item.row));
    range.textContent = matched.length
      ? `显示 ${start + 1}–${end} 条，共 ${matched.length} 条${matched.length === records.length ? '' : `（全部 ${records.length} 条）`}`
      : records.length ? `0 条匹配（全部 ${records.length} 条）` : '';
    empty.hidden = matched.length !== 0;
    empty.textContent = records.length ? '没有匹配的结果，试试其他关键词或重置筛选。' : list.dataset.empty;
    pagination.hidden = records.length <= 10 || matched.length === 0;
    jump.elements.page.value = page;
    jump.elements.page.max = pageCount;
    pageTotal.textContent = `/ ${pageCount}`;
    previous.disabled = page === 1;
    next.disabled = page === pageCount;
  }

  function go(to) {
    page = to;
    render();
    if (list.getBoundingClientRect().top < 0) list.closest('.account').scrollIntoView({ block: 'start' });
  }

  form.addEventListener('submit', event => event.preventDefault());
  form.addEventListener('input', () => { page = 1; render(); });
  form.addEventListener('reset', event => {
    event.preventDefault();
    query.value = '';
    if (status) status.selectedIndex = 0;
    sort.selectedIndex = 0;
    page = 1;
    render();
  });
  size.addEventListener('change', () => { page = 1; render(); });
  previous.addEventListener('click', () => go(page - 1));
  next.addEventListener('click', () => go(page + 1));
  jump.addEventListener('submit', event => {
    event.preventDefault();
    const number = Number(jump.elements.page.value);
    if (Number.isSafeInteger(number) && number > 0) go(number);
  });

  return {
    render,
    locate(row) {
      form.reset();
      page = Math.floor(source.indexOf(row) / Number(size.value)) + 1;
      render();
      row.tabIndex = -1;
      row.focus({ preventScroll: true });
      row.scrollIntoView({ block: 'nearest' });
    },
    source,
  };
}

const accounts = panels.map(panel => {
  const sections = [...panel.querySelectorAll('.content-list')];
  const buttons = [...panel.querySelectorAll('[data-view]')];
  const lists = new Map(sections.map(list => [list.dataset.kind, connectList(list)]));
  function view(name) {
    for (const list of sections) list.hidden = list.dataset.kind !== name;
    for (const button of buttons) button.setAttribute('aria-pressed', String(button.dataset.view === name));
    lists.get(name).render();
  }
  const account = { panel, view, lists, activeView: lists.get('drafts').source.length ? 'drafts' : 'published' };
  for (const button of buttons) button.addEventListener('click', () => {
    account.activeView = button.dataset.view;
    view(account.activeView);
  });
  for (const row of lists.get('drafts').source) tasks.set(row.id, { account, row });
  return account;
});

function navigate() {
  const hash = location.hash.slice(1);
  const task = tasks.get(hash);
  const account = task?.account || accounts.find(item => item.panel.id === hash) || accounts[0];
  if (!account) return;
  for (const item of accounts) item.panel.hidden = item !== account;
  for (const link of links) {
    if (link.hash === '#' + account.panel.id) link.setAttribute('aria-current', 'true');
    else link.removeAttribute('aria-current');
  }
  if (task) account.activeView = 'drafts';
  account.view(account.activeView);
  if (task) account.lists.get('drafts').locate(task.row);
  else if (hash === account.panel.id && account.panel.getBoundingClientRect().top < 0) {
    account.panel.scrollIntoView({ block: 'start' });
  }
}

window.addEventListener('hashchange', navigate);
navigate();
