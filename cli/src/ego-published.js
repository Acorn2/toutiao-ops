import { setTimeout as pause } from 'node:timers/promises';
import { fail } from './errors.js';
import { verifyEgoIdentity } from './ego-draft-page.js';

const ARTICLES = 'https://mp.toutiao.com/profile_v4/graphic/articles';
const FEED = 'https://mp.toutiao.com/api/feed/mp_provider/v1/';
const FILTER = '.articles-wrapper .filter-item:text-is("已发布")';
const PAGE_SIZE = 10;
const NEXT = '.articles-wrapper .byte-pagination-list > .byte-pagination-item-icon:last-child:not(.disabled)';

export function publishedArticleUrl(value) {
  try {
    const url = new URL(value);
    const path = url.pathname.match(/^\/(?:item|article)\/(\d+)\/?$/);
    if (path && !url.username && !url.password && ['https://www.toutiao.com', 'https://toutiao.com'].includes(url.origin)) {
      return `https://www.toutiao.com/${url.pathname.split('/')[1]}/${path[1]}/`;
    }
  } catch { /* Only confirmed public article links are displayed. */ }
  return null;
}

export function readPublishedList({ requirePublished, pageNumber = 1, previousUrls = [] }) {
  const wrapper = document.querySelector('.articles-wrapper');
  const list = wrapper?.querySelector('.article-list');
  const visible = element => element?.getBoundingClientRect().height > 0;
  if (location.pathname !== '/profile_v4/graphic/articles' || !visible(wrapper) ||
    document.querySelector('.byte-tabs-header-title.active')?.textContent.trim() !== '文章' ||
    (requirePublished && wrapper.querySelector('.filter-item.selected')?.textContent.trim() !== '已发布') ||
    wrapper.querySelector('[aria-busy="true"], .byte-spin-loading')) return null;
  const count = list?.querySelector('.search-result')?.innerText.match(/^共\s*(\d+)\s*条内容$/);
  const cards = [...(list?.querySelectorAll(':scope > .article-card') || [])];
  const empty = wrapper.querySelector('.byte-empty');
  const activePage = Number(wrapper.querySelector('.byte-pagination-item-active')?.textContent.trim() || 1);
  if (activePage !== pageNumber) return null;
  if (!cards.length && visible(empty) && /^暂无(?:文章|内容|作品|数据)$/.test(empty.innerText.trim()) && pageNumber === 1) {
    return { total: 0, articles: [] };
  }
  const pageSize = 10;
  const total = Number(count?.[1]);
  const remaining = total - (pageNumber - 1) * pageSize;
  if (!Number.isSafeInteger(total) || !visible(list) || cards.length !== Math.min(remaining, pageSize)) return null;
  const articles = cards.map(card => {
    const title = card.querySelector('.title-wrap a.title');
    const status = [...card.querySelectorAll('.abstruct .byte-tag')].some(tag => tag.textContent.trim() === '已发布');
    return { title: title?.textContent.trim(), url: title?.href, date: card.querySelector('.create-time')?.textContent.trim(), status };
  });
  if (requirePublished && articles.some(article => !article.status || !article.title || !article.url || previousUrls.includes(article.url))) return null;
  return { total, articles };
}

async function waitForFeed(page) {
  const requests = new Set();
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    for (const { method, params } of await page.events()) {
      if (method === 'Network.responseReceived' && params.response.url.split('?')[0] === FEED) {
        if (params.response.status < 200 || params.response.status >= 300) fail('PUBLISHED_LIST_UNAVAILABLE', '头条已发布列表请求未成功');
        requests.add(params.requestId);
      } else if (method === 'Network.loadingFinished' && requests.has(params.requestId)) return;
    }
    await pause(150);
  }
  fail('PUBLISHED_LIST_UNAVAILABLE', '没有收到本次已发布列表的加载证据');
}

export async function readEgoPublications(page, expectedUserId) {
  const identity = await verifyEgoIdentity(page, expectedUserId);
  await page.goto(ARTICLES);
  try {
    await page.waitForFunction(readPublishedList, { requirePublished: false }, { timeout: 15000 });
    await page.cdp('Network.enable', {});
    await page.events();
    await page.click(FILTER, { label: '筛选已发布文章' });
    async function currentPage(pageNumber, previous) {
      await waitForFeed(page);
      const query = { requirePublished: true, pageNumber, previousUrls: previous.map(article => article.url) };
      await page.waitForFunction(readPublishedList, query, { timeout: 12000 });
      const view = await page.evaluate(readPublishedList, query);
      if (!view) fail('PUBLISHED_LIST_UNAVAILABLE', '已发布列表尚未稳定');
      return view;
    }
    const { total, articles: rows } = await currentPage(1, []);
    for (let index = 2; index <= Math.ceil(total / PAGE_SIZE); index++) {
      await page.events();
      await page.click(NEXT, { label: `打开已发布文章第${index}页` });
      const view = await currentPage(index, rows);
      if (view.total !== total) fail('PUBLISHED_LIST_UNAVAILABLE', '同步过程中已发布文章总数发生变化');
      rows.push(...view.articles);
    }
    const articles = rows.map(({ title, url, date }) => ({ title: title.slice(0, 200), url: publishedArticleUrl(url), date: date?.slice(0, 30) }));
    if (articles.some(article => !article.url) || new Set(articles.map(article => article.url)).size !== articles.length) {
      fail('PUBLISHED_LIST_UNAVAILABLE', '无法确认已发布文章的公开链接');
    }
    return { display_name: identity?.username, total, articles };
  } catch (error) {
    return { display_name: identity?.username, error_code: error.code === 'PUBLISHED_LIST_UNAVAILABLE' ? error.code : 'PUBLISHED_LIST_UNAVAILABLE' };
  }
}
