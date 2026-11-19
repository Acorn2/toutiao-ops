import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareArticle, escapeHtml } from '../src/article-input.js';
import { ArticlePage, pasteHtml } from '../src/article-page.js';
import { EgoDraftPage } from '../src/ego-draft-page.js';
import { executeArticle } from '../src/article-workflow.js';
import { ensureLoggedIn, inspectIdentityLink, IDENTITY_LINK, verifyIdentity } from '../src/auth-guard.js';
import { findArticleRecord, snapshot, matchesSnapshot } from '../src/article-records.js';
import { buildPreviewHtml } from '../src/article-preview.js';
import { renderDraftOverview } from '../src/draft-overview.js';
import { readPublishedList } from '../src/ego-published.js';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
const dir = mkdtempSync(join(tmpdir(), 'toutiao-browser-'));
writeFileSync(join(dir, 'one.png'), png);
writeFileSync(join(dir, 'cover.png'), png);
writeFileSync(join(dir, 'article.md'), '## 小标题\n\n**前文**\n\n![第一张](one.png)\n\n中间段落\n\n![再次使用](one.png)\n\n> 引用\n\n- 项目一\n- 项目二\n\n```js\nconst x = 1;\n```\n\n[来源](https://example.com/source)\n\n结尾');
for (let i = 1; i <= 4; i++) writeFileSync(join(dir, `图${i}.png`), Buffer.concat([png, Buffer.from([i])]));
writeFileSync(join(dir, 'ego-media.md'), '# 图文草稿验收\n\n## 小标题\n\n前文 **重点**。\n\n![第一张](图1.png)\n![](图2.png)\n\n> 引用\n\n- 项目一\n- 项目二\n\n![第三张](图3.png)\n\n[来源](https://example.com/source)\n\n原文网址：https://example.com/bare\n\n![第四张](图4.png)');
writeFileSync(join(dir, 'ego-caption.md'), '# 首图图注验收\n\n![首图说明](图1.png)\n\n正文段落。');
writeFileSync(join(dir, 'ego-gallery.md'), '# 纯图草稿验收\n\n![首图说明](图1.png)\n![图二说明](图2.png)');
writeFileSync(join(dir, 'ego-heading.md'), '# 段落小标题间插图\n\n![首图说明](图1.png)\n\n先看 **四份附表**\n\n![第二张图说明](图2.png)\n\n## 下一个小标题\n\n后文。');
let browser;
before(async () => { browser = await chromium.launch({ headless: true, executablePath: process.env.TOUTIAO_TEST_BROWSER || undefined }); });
after(async () => { await browser?.close(); });

test('离线总览支持账号主页、数百篇文章和数十篇草稿的筛选分页', async () => {
  const generated_at = '2026-11-18T07:00:00Z';
  const base = { source_name: 'sample.md', version: '51ea9b2d', updated_at: generated_at };
  const articles = Array.from({ length: 325 }, (_, index) => ({
    title: `教育公报 ${325 - index}`, url: `https://www.toutiao.com/item/${7001 + index}/?source=fixture`, date: '11-18 09:00',
  }));
  articles.at(-1).url = 'https://other.example/item/7004/';
  const html = renderDraftOverview({ generated_at, counts: { pending: 1, running: 0, verified: 1, needs_attention: 1 }, accounts: [
    { account: 'account_a', display_name: '示例手记', ego_profile_bound: true, profile_url: 'https://www.toutiao.com/c/user/100/',
      publications: { total: 325, synced_at: generated_at, articles }, tasks: [
      { ...base, account: 'account_a', id: 'a', title: '一份待存稿', status: 'pending' },
      { ...base, account: 'account_a', id: 'b', title: '一份已核对稿', status: 'verified', verified: true, draft_url: 'https://mp.toutiao.com/profile_v4/graphic/publish?pgc_id=9001' },
      ...Array.from({ length: 45 }, (_, index) => ({ ...base, id: `draft-${index}`, title: `测试稿件 ${index + 1}`, status: 'pending' })),
    ] },
    { account: 'account_b', display_name: '示例观察', ego_profile_bound: true, profile_url: 'https://other.example/c/user/100/', tasks: [
      { ...base, account: 'account_b', id: 'c', title: '<script>需重开核对</script>', status: 'unverified', needs_attention: true, draft_found: true, next: '按编号回查草稿。' },
    ] },
  ] });
  const context = await browser.newContext({ viewport: { width: 360, height: 740 } });
  try {
    const requests = [];
    await context.route('**/*', route => {
      const url = route.request().url();
      requests.push(url);
      if (url === 'http://overview.test/') return route.fulfill({ contentType: 'text/html; charset=utf-8', body: html });
      return route.abort();
    });
    context.setDefaultTimeout(5000);
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto('http://overview.test/');
    assert.equal(await page.getByRole('heading', { name: '头条号发稿总览' }).count(), 1);
    assert.equal(await page.getByRole('link', { name: '账号主页' }).getAttribute('href'), 'https://www.toutiao.com/c/user/100/');
    assert.match(await page.getByRole('status').innerText(), /1–10 条，共 47 条/);
    await page.getByRole('combobox', {name:'草稿状态'}).selectOption('verified');
    assert.equal(await page.getByRole('link', { name: '打开草稿' }).getAttribute('href'), 'https://mp.toutiao.com/profile_v4/graphic/publish?pgc_id=9001');
    await page.getByRole('button', { name: /^已发布文章/ }).click();
    assert.match(await page.getByRole('status').innerText(), /1–10 条，共 325 条/);
    assert.equal(await page.getByRole('link', {name:/查看原文 教育公报 325/}).getAttribute('href'), 'https://www.toutiao.com/item/7001/');
    await page.getByRole('spinbutton', {name:'页码'}).fill('33');
    await page.getByRole('button', {name:'跳转'}).click();
    assert.match(await page.getByRole('status').innerText(), /321–325 条，共 325 条/);
    assert.equal(await page.getByRole('button', {name:'下一页'}).isDisabled(), true);
    await page.getByRole('searchbox', {name:'搜索已发布文章'}).fill('教育公报 １');
    await page.getByRole('combobox', {name:'排序'}).selectOption('title');
    assert.equal(await page.locator('.article-row:visible').first().locator('h4').innerText(), '教育公报 1');
    assert.equal(await page.getByRole('link',{name:'查看原文 教育公报 1',exact:true}).count(), 0);
    await page.getByRole('button', {name:'重置'}).click();
    await page.getByRole('combobox', {name:'每页条数'}).selectOption('20');
    assert.match(await page.getByRole('status').innerText(), /1–20 条/);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
    await page.getByRole('button', { name: /^草稿队列/ }).click();
    assert.equal(await page.getByRole('combobox', {name:'草稿状态'}).inputValue(), 'verified');
    await page.getByRole('button', {name:'重置'}).click();
    await page.getByRole('spinbutton', {name:'页码'}).fill('5');
    await page.getByRole('button', {name:'跳转'}).click();
    assert.match(await page.getByRole('status').innerText(), /41–47 条/);
    await page.getByRole('searchbox', {name:'搜索草稿队列'}).fill('测试稿件 45');
    assert.match(await page.getByRole('status').innerText(), /共 1 条/);
    await page.getByRole('link', { name: /^示例观察/ }).click();
    assert.ok(page.url().endsWith('#account-account_b'));
    await page.getByText('需要处理 1 条', {exact:true}).click();
    await page.getByRole('link', { name: /需重开核对/ }).click();
    assert.ok(page.url().endsWith('#task-c'));
    assert.equal(await page.getByText('已找到草稿，全文核对未通过').isVisible(), true);
    assert.equal(await page.getByRole('link', { name: '账号主页' }).count(), 0);
    assert.equal(await page.locator('script').count(), 1);
    assert.deepEqual(errors, []);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
    await page.setViewportSize({ width: 1280, height: 850 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
    assert.deepEqual(requests, ['http://overview.test/']);
  } finally { await context.close(); }
});

test('已发布列表要求文章页、所选筛选和匹配的页码，拒绝旧页和未发布记录', async () => {
  const context = await browser.newContext();
  try {
    const url = 'https://mp.toutiao.com/profile_v4/graphic/articles';
    await context.route('**/*', route => route.request().url() === url ? route.fulfill({ contentType: 'text/html', body: '<meta charset="utf-8">' }) : route.abort());
    const page = await context.newPage();
    await page.goto(url);
    await page.setContent(`<div class="byte-tabs-header-title active">文章</div><div class="articles-wrapper">
      <span class="filter-item selected">全部</span><div class="article-list"><p class="search-result">共 11 条内容</p>
      <div class="article-card"><div class="title-wrap"><a class="title" href="https://www.toutiao.com/item/7001/">样稿</a>
      <span class="create-time">11-19 09:00</span></div><div class="abstruct"><div class="byte-tag">审核中</div></div></div></div>
      <span class="byte-pagination-item-active">2</span></div>`);
    const status = { requirePublished: true, pageNumber: 2 };
    assert.equal(await page.evaluate(readPublishedList, status), null);
    await page.locator('.filter-item').evaluate(element => { element.textContent = '已发布'; });
    assert.equal(await page.evaluate(readPublishedList, status), null);
    await page.locator('.byte-tag').evaluate(element => { element.textContent = '已发布'; });
    assert.equal((await page.evaluate(readPublishedList, status)).total, 11);
    assert.equal(await page.evaluate(readPublishedList, { ...status, pageNumber: 1 }), null);
    assert.equal(await page.evaluate(readPublishedList, { ...status, previousUrls: ['https://www.toutiao.com/item/7001/'] }), null);
  } finally { await context.close(); }
});

test('账号核对只接受唯一的 HTTPS 头条主页链接', async () => {
  const context = await browser.newContext();
  try {
    await context.route('**/*', route => route.abort());
    const page = await context.newPage();
    for (const href of ['https://example.com/c/user/100/', 'http://www.toutiao.com/c/user/100/',
      'https://www.toutiao.com/other/user/100/', 'https://www.toutiao.com/c/user/100/details']) {
      await page.setContent(`<div class="information"><a href="${href}">账号</a></div>`);
      assert.equal(await page.evaluate(inspectIdentityLink, IDENTITY_LINK), null);
    }
    const profile = '<a href="https://www.toutiao.com/c/user/100/?enter_from=mp_profile">账号</a>';
    await page.setContent(`<div class="information">${profile}${profile}</div>`);
    assert.equal(await page.evaluate(inspectIdentityLink, IDENTITY_LINK), null);
    await page.setContent(`<div class="information">${profile}</div>`);
    assert.deepEqual(await page.evaluate(inspectIdentityLink, IDENTITY_LINK), { userId: '100', username: '账号' });
  } finally { await context.close(); }
});

function editorHtml(record, config) {
  return `<!doctype html><meta charset="utf-8"><style>[contenteditable]{min-height:200px;border:1px solid} [hidden]{display:none!important} img{width:24px;height:24px}</style>
    <div class="information"><a href="https://www.toutiao.com/c/user/100/">主页</a><span class="auth-avator-name">fixture</span></div>
    <h1>${escapeHtml(record?.title || '')}</h1>
    <textarea placeholder="请输入文章标题" maxlength="30">${escapeHtml(record?.title || '')}</textarea>
    <div contenteditable="true"${config.autoDraft ? ' class="ProseMirror"' : ''}>${record?.html || (config.autoDraft ? '<p><span class="syl-placeholder ProseMirror-widget" hidden>请输入正文</span><br></p>' : '')}</div>
    <button id="image">图片</button>
    ${config.egoMedia ? `<div class="syl-toolbar-tool image static"><button>添加图片</button></div>
    <div class="article-cover"><div class="article-cover-radio-group">${['无封面', '单图', '三图'].map(mode => `<label class="byte-radio"><input type="radio" name="ego-cover"${mode === (record?.mode || '无封面') ? ' checked' : ''}><span class="byte-radio-inner" style="display:inline-block;width:16px;height:16px"></span>${mode}</label>`).join('')}</div><div class="article-cover-images">${(record?.covers || []).map(src => `<div class="article-cover-img-wrap"><img src="${escapeHtml(src)}"><button class="article-cover-img-replace">替换</button></div>`).join('')}</div></div>
    <div class="mp-ic-img-drawer" hidden><div class="upload-btn"><input type="file" accept="image/*"></div>
      <div class="byte-tabs-content-item-active"></div><div class="pgc-text-img"></div><span class="select-count"></span><button class="confirm-selection" hidden>确定</button></div>` : ''}
    <label${config.autoDraft ? ' class="byte-radio"' : ''}><input ${config.autoDraft ? 'style="display:none" ' : ''}type="radio" name="cover-mode">无封面</label><label><input type="radio" name="cover-mode">单图</label>
    <div class="cover"><button class="upload" id="cover">添加封面</button><span id="cover-image">${record?.cover ? `<img src="${record.cover}">` : ''}</span></div>
    ${config.noSyncControl ? '' : config.autoDraft ? '<div class="form-tuwen_wtt_trans"><div>同时发布微头条</div><input id="sync" type="checkbox" checked></div>' : '<label><input id="sync" type="checkbox" checked>同时发布微头条</label>'}
    ${config.autoDraft ? '<div class="footer-draft-save"><span class="footer-tip-save">草稿将自动保存</span></div>' : (config.missingSave ? '' : '<button id="save">保存草稿</button>')}
    <button id="preview">预览并发布</button><button id="publish" hidden>确认发布</button>
    <div role="dialog" hidden><input type="file" accept="image/*"><div id="upload-state"></div><button id="insert">确定</button></div>
    ${config.egoDraft && !config.missingExternalLinkTool ? `
      <div class="syl-toolbar-tool link static"><button>链接</button></div>
      <div id="link-dialog" role="dialog" hidden>
        <button class="byte-tabs-header-title">外部链接</button>
        <div id="link-fields" hidden><input placeholder="填写链接地址"></div>
        <button class="byte-btn-primary" id="confirm-link">确定</button>
      </div>` : ''}
    <div id="toast"></div>
    <script>
      const editor = document.querySelector('[contenteditable]');
      const dialog = document.querySelector('[role=dialog]');
      let range, coverMode = false, source;
      editor.addEventListener('paste', event => {
        event.preventDefault();
        if (editor.querySelector('.syl-placeholder')) editor.replaceChildren();
        document.execCommand('insertHTML', false, event.clipboardData.getData('text/html'));
      });
      function openUpload(cover) { coverMode = cover; if (!cover) range = getSelection().getRangeAt(0).cloneRange(); dialog.hidden = false; document.querySelector('#upload-state').innerHTML = ''; }
      document.querySelector('#image').addEventListener('mousedown', e => e.preventDefault());
      document.querySelector('#image').onclick = () => openUpload(false);
      document.querySelector('#cover').onclick = () => openUpload(true);
      dialog.querySelector('input[type=file]').onchange = async event => {
        await window.fixtureUpload();
        if (${!!config.uploadFailure}) { document.querySelector('#upload-state').textContent = '上传失败'; return; }
        source = 'https://mp.toutiao.com/fixture-image/' + event.target.files[0].name;
        document.querySelector('#upload-state').innerHTML = '<span>上传成功</span><img src="' + source + '">';
      };
      document.querySelector('#insert').onclick = () => {
        if (coverMode) document.querySelector('#cover-image').innerHTML = '<img src="' + source + '">';
        else { editor.focus(); const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range); document.execCommand('insertHTML', false, '<img src="' + source + '">'); }
        dialog.hidden = true;
      };
      async function save(status) {
        const radio = document.querySelector('.article-cover-radio-group input:checked');
        const covers = [...document.querySelectorAll('.article-cover-images img')].map(img => img.src);
        await window.fixtureSave({ title: document.querySelector('textarea').value, html: editor.innerHTML, cover: document.querySelector('#cover-image img')?.src || null, mode: radio?.parentElement.textContent.trim(), covers, status,
          mediaOverlap: Number(document.body.dataset.mediaOverlap || 0) });
        document.querySelector('#toast').textContent = status === '草稿' ? '草稿保存成功' : '已提交审核';
      }
      if (document.querySelector('#save')) document.querySelector('#save').onclick = () => save('草稿');
      const draftStatus = document.querySelector('.footer-tip-save');
      if (draftStatus) {
        if (${!!config.nativeTextDraft}) {
          editor.addEventListener('beforeinput', event => {
            if (event.isTrusted && event.inputType === 'insertText') {
              editor.dataset.nativeTextInput = 'true';
              editor.querySelector('.syl-placeholder')?.remove();
            }
          });
          editor.addEventListener('paste', () => { editor.dataset.pasted = 'true'; });
        }
        let draftId = ${JSON.stringify(record?.id || '')};
        function requestContent() {
          const copy = editor.cloneNode(true);
          copy.querySelectorAll('syl-inline').forEach(node => node.replaceWith(node.querySelector('templ > a')));
          copy.querySelectorAll('.pgc-img-caption-ipt').forEach((field, index) => {
            const image = copy.querySelectorAll('img[web_uri]')[index];
            const block = [...copy.children].find(node => node.contains(field));
            const figure = document.createElement('figure');
            const caption = document.createElement('figcaption');
            caption.textContent = editor.querySelectorAll('.pgc-img-caption-ipt')[index].value;
            figure.append(image, caption);
            block.replaceWith(figure);
          });
          return copy.innerHTML;
        }
        let draftTimer, completedEdits = 0;
        function scheduleDraft() {
          draftStatus.textContent = '草稿保存中...';
          clearTimeout(draftTimer);
          draftTimer = setTimeout(async () => {
            if (++completedEdits <= ${config.egoDraft ? 0 : 3}) return;
            if (${!!config.egoDraft}) {
              if (!editor.textContent.replace('请输入正文', '').trim() && !editor.querySelector('img[web_uri]')) return;
              const body = {
                save: '0', pgc_id: draftId || '0', title: document.querySelector('textarea').value, content: requestContent(),
                pgc_feed_covers: [...document.querySelectorAll('.article-cover-images img')].map(img => ({ url: img.src })),
              };
              const send = content => fetch('/mp/agw/article/publish', {
                method: 'POST', headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ ...body, content }),
              }).then(response => response.json());
              if (${!!config.rejectSecondCaption} && body.content.includes('<figcaption>图2</figcaption>')) {
                await send(body.content.replace('<figcaption>图2</figcaption>', '<figcaption></figcaption>'));
                draftStatus.textContent = '草稿已保存';
              }
              const response = await send(body.content);
              if (response.code !== 0) return;
              draftId = response.data.pgc_id;
            } else if (${!!config.draftRejection}) {
              await fetch('/mp/agw/article/publish', { method: 'POST' });
              return;
            }
            await save('草稿');
            draftStatus.textContent = '草稿已保存';
          }, 250);
        }
        editor.addEventListener('input', scheduleDraft);
        document.querySelector('textarea').addEventListener('input', scheduleDraft);
        const linkTool = document.querySelector('.syl-toolbar-tool.link button');
        if (linkTool) {
          const modal = document.querySelector('#link-dialog');
          const tab = modal.querySelector('.byte-tabs-header-title');
          const fields = modal.querySelector('#link-fields');
          const address = fields.querySelector('input');
          let linkRange;
          linkTool.onmousedown = event => event.preventDefault();
          linkTool.onclick = () => {
            linkRange = getSelection().getRangeAt(0).cloneRange();
            modal.hidden = false;
            fields.hidden = true;
            fields.className = '';
            tab.classList.remove('active');
          };
          tab.onclick = () => {
            tab.classList.add('active');
            fields.hidden = false;
            fields.className = 'byte-tabs-content-item-active';
          };
          modal.querySelector('#confirm-link').onclick = () => {
            const inline = document.createElement('syl-inline');
            inline.contentEditable = 'false';
            const link = document.createElement('a');
            link.className = 'pgc-link';
            link.href = ${!!config.externalLinkWrongTarget} ? 'https://wrong.example/' : address.value;
            link.textContent = '平台生成标题';
            for (const tag of ['templ', 'mask']) {
              const wrapper = document.createElement(tag);
              wrapper.hidden = tag === 'templ';
              wrapper.append(link.cloneNode(true));
              inline.append(wrapper);
            }
            linkRange.insertNode(inline);
            modal.hidden = true;
            scheduleDraft();
          };
        }
        if (${!!config.egoMedia}) {
          const drawer = document.querySelector('.mp-ic-img-drawer');
          const uploader = drawer.querySelector('.upload-btn');
          const preview = drawer.querySelector('.byte-tabs-content-item-active');
          const picker = drawer.querySelector('.pgc-text-img');
          const confirm = drawer.querySelector('.confirm-selection');
          const slots = document.querySelector('.article-cover-images');
          let bodyRange, uploadSrc, choices, inserting, coverSlot;
          const mediaURL = uri => 'https://image-tt-private.toutiao.com/' + uri + '?x-orig-sign=initial';
          const count = () => document.querySelector('.article-cover-radio-group input:checked').parentElement.textContent === '三图' ? 3 : 1;
          const countOverlap = () => {
            if (draftStatus.textContent !== '草稿已保存') {
              document.body.dataset.mediaOverlap = String(Number(document.body.dataset.mediaOverlap || 0) + 1);
            }
          };
          const addSlot = src => src
            ? '<div class="article-cover-img-wrap" style="min-height:28px"><button class="article-cover-img-replace">替换</button><img src="' + src + '"></div>'
            : '<div class="article-cover-add" style="min-height:28px">添加封面</div>';
          function open(adding) {
            inserting = adding;
            drawer.hidden = false;
            uploader.hidden = !adding;
            preview.replaceChildren();
            picker.replaceChildren();
            drawer.querySelector('.select-count').textContent = '';
            confirm.hidden = true;
            choices = [];
            uploader.querySelector('input').value = '';
          }
          document.querySelector('.syl-toolbar-tool.image button').addEventListener('mousedown', e => e.preventDefault());
          document.querySelector('.syl-toolbar-tool.image button').onclick = () => {
            bodyRange = getSelection().getRangeAt(0).cloneRange();
            open(true);
          };
          uploader.querySelector('input').onchange = async event => {
            const number = [...event.target.files[0].name].find(char => '1234'.includes(char));
            await window.fixtureUpload();
            if (${!!config.uploadFailure} || number === ${JSON.stringify(String(config.uploadFailureAt || ''))}) { preview.textContent = '上传失败'; return; }
            uploadSrc = mediaURL('tos-fixture/image-' + number);
            preview.textContent = '已上传 1 张图片，支持拖拽调整图片顺序';
            confirm.hidden = false;
          };
          editor.addEventListener('input', event => {
            if (event.target.matches('textarea.pgc-img-caption-ipt')) event.target.textContent = event.target.value;
          });
          editor.addEventListener('focusin', event => {
            if (event.target.matches('textarea.pgc-img-caption-ipt')) {
              countOverlap();
              editor.contentEditable = 'false';
            }
          });
          editor.addEventListener('focusout', event => {
            if (event.target.matches('textarea.pgc-img-caption-ipt')) editor.contentEditable = 'true';
          });
          document.querySelector('.article-cover-radio-group').onchange = event => {
            countOverlap();
            slots.innerHTML = event.target.parentElement.textContent === '无封面' ? '' : addSlot('').repeat(count());
            scheduleDraft();
          };
          slots.onclick = event => {
            const slot = event.target.closest('.article-cover-img-wrap, .article-cover-add');
            if (!slot) return;
            coverSlot = [...slots.children].indexOf(slot);
            open(false);
            for (const img of editor.querySelectorAll('.pgc-img img')) {
              const item = document.createElement('div');
              item.className = 'resource-item-txt';
              const thumb = document.createElement('span');
              thumb.className = 'img-span';
              thumb.style.cssText = 'display:inline-block;width:24px;height:24px;background-image:url("' + img.src + '")';
              thumb.onclick = () => {
                choices.push(img.src);
                drawer.querySelector('.select-count').textContent = '最多可选择' + count() + '张';
                confirm.hidden = false;
                confirm.disabled = choices.length !== count();
              };
              item.append(thumb);
              picker.append(item);
            }
          };
          confirm.onclick = () => {
            if (inserting) {
              const card = document.createElement('div');
              card.contentEditable = 'false';
              const uri = new URL(uploadSrc).pathname.slice(1);
              card.innerHTML = '<div class="pgc-img" hidden><img web_uri="' + uri + '" src="' + uploadSrc + '"></div><div class="img-loading-container"><img src="' + uploadSrc + '"></div><textarea class="pgc-img-caption-ipt"></textarea>';
              if (${!!config.blockFirstCaptionClick} && uri.endsWith('image-1')) {
                const caption = card.querySelector('textarea');
                const wrapper = document.createElement('div');
                wrapper.style.cssText = 'position:relative;display:inline-block';
                caption.replaceWith(wrapper);
                const blocker = document.createElement('div');
                blocker.style.cssText = 'position:absolute;inset:0;z-index:1';
                wrapper.append(caption, blocker);
              }
              const anchor = bodyRange.startContainer;
              if (anchor === editor) {
                const next = editor.childNodes[bodyRange.startOffset];
                if (${!!config.headingRangeDrift} && next?.nodeName === 'H1') next.after(card);
                else editor.insertBefore(card, next || null);
              } else {
                const block = [...editor.children].find(node => node.contains(anchor));
                if (${!!config.misplaceImage}) editor.append(card);
                else if (bodyRange.startOffset === 0) block.before(card);
                else block.after(card);
              }
              editor.querySelector('.syl-placeholder')?.remove();
            } else if (choices.length === 3) slots.innerHTML = choices.map(addSlot).join('');
            else slots.children[coverSlot].outerHTML = addSlot(choices[0]);
            drawer.hidden = true;
            scheduleDraft();
          };
        }
      }
      document.querySelector('#preview').onclick = () => { document.querySelector('#publish').hidden = false; };
      document.querySelector('#publish').onclick = () => save('审核中');
    </script>`;
}

async function fixture(config = {}) {
  const context = await browser.newContext();
  context.setDefaultTimeout(3000);
  const records = structuredClone(config.initialRecords || []);
  let saves = 0, uploads = 0;
  const requests = [], draftRequests = [];
  await context.exposeBinding('fixtureSave', (_source, value) => {
    saves++;
    let html = value.html;
    if (config.tamperPersisted) html = '<p>平台未保存完整正文</p>';
    if (config.persistFirstParagraph) html = html.slice(0, html.indexOf('</p>') + '</p>'.length);
    if (!config.noPersistence && (config.egoMedia || config.egoDraft)) {
      const index = records.findIndex(record => record.title === value.title);
      const updated = { ...value, html: html.replaceAll('x-orig-sign=initial', 'x-orig-sign=reopened'),
        covers: value.covers.map(src => src.replace('x-orig-sign=initial', 'x-orig-sign=reopened')),
        id: index === -1 ? String(1000 + saves) : records[index].id };
      if (index === -1) records.push(updated);
      else records[index] = updated;
    } else if (!config.noPersistence) records.push({ ...value, html, id: String(1000 + saves) });
  });
  await context.exposeBinding('fixtureUpload', () => {
    uploads++;
    return config.waitForUpload?.(uploads);
  });
  await context.exposeBinding('fixtureList', async (_source, kind) => {
    if (config.listDelay) await new Promise(resolve => setTimeout(resolve, config.listDelay));
    return records.filter(record => kind === 'draft' ? record.status === '草稿' : record.status !== '草稿');
  });
  // Every request is fulfilled from memory, even requests using the production hostname.
  // There is no fallback/continue path and no real platform or local account profile.
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    requests.push(url.pathname);
    if (url.pathname.startsWith('/fixture-image/')) return route.fulfill({ contentType: 'image/png', body: png });
    if (url.hostname === 'image-tt-private.toutiao.com' && url.pathname.startsWith('/tos-fixture/')) return route.fulfill({ contentType: 'image/png', body: png });
    if (url.pathname === '/mp/agw/article/publish') {
      if (!config.egoDraft && config.draftRejection) return route.fulfill({ json: { code: 7050 } });
      const data = route.request().postDataJSON();
      draftRequests.push(data);
      if (config.draftRejection || (config.rejectSecondCaption && data.content.includes('<figcaption>图2</figcaption>'))) {
        if (config.rejectSecondCaption) await new Promise(resolve => setTimeout(resolve, 600));
        return route.fulfill({ json: { code: 7050 } });
      }
      return route.fulfill({ json: { code: 0, data: { pgc_id: '1001' } } });
    }
    let html;
    if (url.pathname === '/profile_v4/index') html = '<div class="information"><a href="https://www.toutiao.com/c/user/100/">主页</a><span class="auth-avator-name">fixture</span></div>';
    else if (url.pathname === '/profile_v4/manage/content/all' && config.dedicatedDraftPage) {
      html = '<meta charset="utf-8"><div class="management_tab"><div class="byte-menu-item"><a href="/profile_v4/manage/draft">草稿箱</a></div></div>';
    } else if (url.pathname === '/profile_v4/manage/draft' && config.dedicatedDraftPage) {
      const empty = '<div class="byte-empty no-content">暂无草稿</div>';
      const drafts = records.filter(record => record.status === '草稿');
      const rows = drafts.map(draft => config.nativeDraftCards
        ? `<div class="article-draft-item draft-item"><a class="title">${escapeHtml(draft.title)}</a>${config.missingEdit ? '' : `<a class="op-button" onclick="window.open('/profile_v4/graphic/publish?pgc_id=${draft.id}')">编辑</a>`}</div>`
        : `<div class="genre-item" data-article-id="${draft.id}"><a class="title" href="/profile_v4/graphic/publish?id=${draft.id}">${escapeHtml(draft.title)}</a></div>`).join('');
      html = `<meta charset="utf-8"><div class="management_tab"><div class="byte-menu-item selected"><a class="active" href="/profile_v4/manage/draft">草稿箱</a></div></div>
        <div class="manage_draft-wrapper"><main><div class="draft-page"><div class="filters">草稿筛选</div>
        <div class="list-count">共 ${drafts.length} 条内容</div>${drafts.length || config.missingViewEvidence ? '' : empty}
        <div class="list">${rows}</div></div></main></div>
        ${config.missingViewEvidence ? empty : '<div class="genre-item"><span class="title">旧作品行</span></div>'}`;
    } else if (url.pathname === '/profile_v4/manage/content/all') {
      const rows = records.filter(record => record.status !== '草稿').map(r => `<div class="genre-item" data-article-id="${r.id}"><a class="title" href="https://mp.toutiao.com/profile_v4/graphic/publish?id=${r.id}">${escapeHtml(r.title)}</a><span class="status">${r.status}</span></div>`).join('') || '<p>暂无内容</p>';
      html = `<meta charset="utf-8"><div role="tablist"><button id="published-tab" role="tab" aria-selected="true" aria-controls="published-panel">全部作品</button><button id="draft-tab" role="tab" aria-selected="false" aria-controls="draft-panel">草稿箱</button></div>
        <div id="published-panel" role="tabpanel" aria-labelledby="published-tab" aria-busy="false">${rows}</div>
        <div id="draft-panel" role="tabpanel" aria-labelledby="draft-tab" aria-busy="true" hidden></div>
        <script>
        document.querySelector('#draft-tab').onclick = async () => {
          document.querySelector('#published-tab').setAttribute('aria-selected', 'false');
          document.querySelector('#draft-tab').setAttribute('aria-selected', 'true');
          const panel = document.querySelector('#draft-panel');
          panel.setAttribute('aria-busy', 'true');
          const records = await window.fixtureList('draft');
          panel.innerHTML = records.map(record => {
            const row = document.createElement('div'); row.className = 'genre-item'; row.dataset.articleId = record.id;
            const link = document.createElement('a'); link.className = 'title'; link.href = 'https://mp.toutiao.com/profile_v4/graphic/publish?id=' + record.id; link.textContent = record.title;
            const state = document.createElement('span'); state.className = 'status'; state.textContent = record.status;
            row.append(link, state); return row.outerHTML;
          }).join('') || '<p>暂无草稿</p>';
          panel.hidden = false; panel.setAttribute('aria-busy', 'false'); document.querySelector('#published-panel').hidden = true;
        };
        </script>`;
      if (config.missingViewEvidence) html = html.replaceAll('aria-controls=', 'data-unused-controls=');
    } else if (url.pathname === '/profile_v4/graphic/publish') html = editorHtml(records.find(r => r.id === (url.searchParams.get('id') || url.searchParams.get('pgc_id'))) || config.restoredRecord, config);
    else return route.fulfill({ status: 404, body: 'fixture-only; network blocked' });
    return route.fulfill({ contentType: 'text/html; charset=utf-8', body: html });
  });
  const page = await context.newPage();
  const driver = new ArticlePage(context, page, 'fixture_account');
  driver.assertIdentity = async () => {
    const check = await context.newPage();
    try { verifyIdentity(await ensureLoggedIn(check), { userId: '100' }); }
    finally { await check.close(); }
  };
  driver.diagnose = async stage => ({ stage }); // Do not write into the user's account tree.
  let entry = null;
  const store = { read: () => entry, write: value => { entry = structuredClone(value); } };
  return { context, driver, store, records, requests, draftRequests, get saves() { return saves; }, get uploads() { return uploads; } };
}

test('受控页面：真实点击保存，重新打开记录校验正文后成功', async () => {
  const f = await fixture();
  try {
    const opts = { account: 'fixture_account', draft: true, title: '纯文字草稿', content: '## 小标题\n\n**正文**\n\n[链接](https://example.com/source)' };
    const input = prepareArticle(opts);
    const result = await executeArticle(opts, input, f.driver, f.store);
    assert.equal(result.status, 'draft_saved', JSON.stringify(result));
    assert.equal(result.verified, true); assert.equal(f.saves, 1);
    assert.ok(f.requests.filter(p => p.includes('graphic/publish')).length >= 2);
    assert.ok(!JSON.stringify(f.store.read().manifest).includes('正文'));
  } finally { await f.context.close(); }
});
test('受控页面：新草稿忽略前三次保存触发时，分步填写后回查正文', async () => {
  const f = await fixture({ autoDraft: true, dedicatedDraftPage: true });
  try {
    const opts = { account: 'fixture_account', draft: true, title: '自动保存示例', content: '## 小标题\n\n第一段正文\n\n第二段**加粗**正文' };
    const result = await executeArticle(opts, prepareArticle(opts), f.driver, f.store);
    assert.equal(result.status, 'draft_saved', JSON.stringify({ result, editor: await f.driver.page.locator('[contenteditable]').innerHTML() }));
    assert.equal(f.saves, 1);
    assert.equal(f.records[0].status, '草稿');
    assert.equal(await f.driver.page.locator('#sync').isChecked(), false);
  } finally { await f.context.close(); }
});

function egoFixtureTask(fixture, { firstCaptionAutoFocus = false } = {}) {
  const pasted = [];
  const editorErrors = [];
  let autoFocused = false;
  function wrap(page) {
    const events = [];
    let session;
    const monitor = async () => {
      if (!session) {
        session = fixture.context.newCDPSession(page);
        const target = await session;
        for (const name of ['Network.requestWillBeSent', 'Network.responseReceived', 'Network.loadingFailed']) {
          target.on(name, params => events.push({ method: name, params }));
        }
      }
      return session;
    };
    return {
      cdp: async (method, params) => (await monitor()).send(method, params),
      events: async () => events.splice(0),
      goto: url => page.goto(url),
      url: () => page.url(),
      async evaluate(fn, arg) {
        let value;
        try { value = await page.evaluate(fn, arg); }
        catch (error) { editorErrors.push(error.message); throw error; }
        // Put the focus event between upload verification and position reading,
        // where the live editor can temporarily switch contenteditable off.
        if (firstCaptionAutoFocus && !autoFocused && value === 'inserted') {
          autoFocused = true;
          await page.locator('.pgc-img-caption-ipt').first().focus();
        }
        return value;
      },
      waitForFunction: (fn, arg, options) => page.waitForFunction(fn, arg, options),
      waitForSelector: (selector, options) => page.waitForSelector(selector, options),
      waitForURL: (url, options) => page.waitForURL(url, options),
      waitForEvent: async (event, options) => wrap(await page.waitForEvent(event, options)),
      click: selector => page.locator(selector).click(),
      fill: (selector, value) => page.locator(selector).fill(value),
      focus: selector => page.locator(selector).focus(),
      setInputFiles: (selector, paths) => page.locator(selector).setInputFiles(paths),
      keyboard: { press: key => page.keyboard.press(key), async paste(value) {
        pasted.push(value);
        if (typeof value === 'string') await page.keyboard.insertText(value);
        else await pasteHtml(page, value.html, value.text);
      } },
    };
  }
  return { page: () => wrap(fixture.driver.page), newPage: async () => wrap(await fixture.context.newPage()), pasted, editorErrors };
}

function egoFixtureDriver(task) {
  return new EgoDraftPage(task, '100');
}

test('受控页面：Ego 一次粘贴整篇正文，重开后核对完整草稿', async () => {
  const f = await fixture({ autoDraft: true, egoDraft: true, dedicatedDraftPage: true, nativeDraftCards: true });
  try {
    const task = egoFixtureTask(f);
    const opts = { account: 'fixture_account', draft: true, title: 'Ego 草稿验收', content: '第一段正文\n\n第二段**加粗**正文' };
    const input = prepareArticle(opts);
    const result = await executeArticle(opts, input, egoFixtureDriver(task), f.store);
    assert.equal(result.status, 'draft_saved', JSON.stringify(result));
    assert.equal(result.article_id, '1001');
    assert.deepEqual(task.pasted, [input.title, { text: input.content, html: input.html }]);
    assert.equal(f.saves, 1);
  } finally { await f.context.close(); }
});

test('受控页面：Ego 首图图注自动获得焦点时仍能填图注并保存', async () => {
  const f = await fixture({ autoDraft: true, egoDraft: true, egoMedia: true, dedicatedDraftPage: true, nativeDraftCards: true });
  try {
    const task = egoFixtureTask(f, { firstCaptionAutoFocus: true });
    const opts = { account: 'fixture_account', draft: true, contentFile: join(dir, 'ego-caption.md') };
    const result = await executeArticle(opts, prepareArticle(opts), egoFixtureDriver(task), f.store);
    assert.equal(result.status, 'draft_saved', JSON.stringify({ result, editorErrors: task.editorErrors }));
    assert.match(f.records[0].html, />首图说明<\/textarea>/);
  } finally { await f.context.close(); }
});

test('受控页面：Ego 首图图注点击被挡住时仍能聚焦、粘贴并保存', async () => {
  const f = await fixture({ autoDraft: true, egoDraft: true, egoMedia: true, dedicatedDraftPage: true, nativeDraftCards: true, blockFirstCaptionClick: true });
  try {
    const opts = { account: 'fixture_account', draft: true, contentFile: join(dir, 'ego-caption.md') };
    const result = await executeArticle(opts, prepareArticle(opts), egoFixtureDriver(egoFixtureTask(f)), f.store);
    assert.equal(result.status, 'draft_saved', JSON.stringify(result));
    assert.match(f.records[0].html, />首图说明<\/textarea>/);
  } finally { await f.context.close(); }
});

test('受控页面：Ego 识别明确业务拒绝并提前回查草稿箱', async () => {
  const f = await fixture({ autoDraft: true, egoDraft: true, dedicatedDraftPage: true, nativeDraftCards: true, draftRejection: true });
  try {
    const opts = { account: 'fixture_account', draft: true, title: '明确拒绝的草稿', content: '只测试草稿拒绝与回查。' };
    const input = prepareArticle(opts);
    const start = performance.now();
    const result = await executeArticle(opts, input, egoFixtureDriver(egoFixtureTask(f)), f.store);
    assert.equal(result.error_code, 'DRAFT_SAVE_REJECTED', JSON.stringify(result));
    assert.match(result.message, /7050/);
    assert.equal(result.diagnostic.lookup.complete, true);
    assert.equal(f.requests.filter(path => path === '/mp/agw/article/publish').length, 1);
    assert.ok(performance.now() - start < 20_000);
  } finally { await f.context.close(); }
});

test('受控页面：Ego 缺少同步开关时仍保存 Markdown、四张图的描述和三图封面', async () => {
  const f = await fixture({ autoDraft: true, egoDraft: true, egoMedia: true, dedicatedDraftPage: true, nativeDraftCards: true, noSyncControl: true });
  try {
    const opts = { account: 'fixture_account', draft: true, contentFile: join(dir, 'ego-media.md') };
    const input = prepareArticle(opts);
    const driver = egoFixtureDriver(egoFixtureTask(f));
    const result = await executeArticle(opts, input, driver, f.store);
    assert.equal(result.status, 'draft_saved', JSON.stringify(result));
    assert.equal(f.uploads, 4);
    assert.equal(f.records.length, 1);
    const [saved] = f.records;
    assert.equal(saved.status, '草稿');
    assert.equal(saved.mediaOverlap, 0);
    assert.match(saved.html, /<h1>小标题<\/h1>/);
    assert.match(saved.html, /<strong>重点<\/strong>/);
    assert.match(saved.html, /<blockquote>/);
    assert.match(saved.html, /<a href="https:\/\/example.com\/source">来源<\/a>/);
    assert.match(saved.html, /原文网址：<syl-inline[^>]*>.*?class="pgc-link" href="https:\/\/example.com\/bare"/);
    assert.doesNotMatch(saved.html, /原文网址：https:/);
    assert.deepEqual([...saved.html.matchAll(/class="pgc-img-caption-ipt">([^<]+)/g)].map(match => match[1]), ['第一张', '图2', '第三张', '第四张']);
    assert.ok(f.draftRequests.every(request => !request.content.includes('TTOPSIMG')));
    assert.equal(saved.mode, '三图');
    assert.deepEqual(saved.covers.map(src => new URL(src).pathname), ['/tos-fixture/image-1', '/tos-fixture/image-2', '/tos-fixture/image-3']);
    assert.ok(saved.covers.every(src => src.includes('x-orig-sign=reopened')));
    const manifest = JSON.stringify(f.store.read().manifest);
    assert.doesNotMatch(manifest, /x-orig-sign|第一张/);
    assert.equal((await executeArticle(opts, input, driver, f.store)).verified, true);
    assert.equal(f.uploads, 4);
  } finally { await f.context.close(); }
});

test('受控页面：Ego 外链保留原有位置并验证重开后的目标地址', async () => {
  const f = await fixture({ autoDraft: true, egoDraft: true, dedicatedDraftPage: true, nativeDraftCards: true });
  try {
    const opts = { account: 'fixture_account', draft: true, title: '外链草稿验收',
      content: '来源 https://example.com/a （第一处）\n\n延伸 https://example.com/a/b 之后是 https://example.com/a' };
    const input = prepareArticle(opts);
    const driver = egoFixtureDriver(egoFixtureTask(f));
    const result = await executeArticle(opts, input, driver, f.store);
    assert.equal(result.status, 'draft_saved', JSON.stringify(result));
    assert.equal(f.records.length, 1);
    assert.match(f.records[0].html, /<\/syl-inline> （第一处）/);
    assert.equal(f.store.read().manifest.egoExternalLinkCount, 3);
    const nativeUrls = f.draftRequests.at(-1).content.match(/href="[^"]+"/g);
    assert.deepEqual(nativeUrls, ['href="https://example.com/a"', 'href="https://example.com/a/b"', 'href="https://example.com/a"']);
    const entry = f.store.read();
    delete entry.manifest.egoExternalLinkCount;
    f.store.write(entry);
    const reconcile = await executeArticle(opts, input, driver, f.store);
    assert.equal(reconcile.verified, false);
    assert.equal(reconcile.diagnostic.lookup.external_links_need_update, true);
  } finally { await f.context.close(); }
});

test('受控页面：Ego 外链工具返回错误地址时保留原址并停止', async () => {
  const f = await fixture({ autoDraft: true, egoDraft: true, dedicatedDraftPage: true, nativeDraftCards: true, externalLinkWrongTarget: true });
  try {
    const opts = { account: 'fixture_account', draft: true, title: '外链异常验收', content: '来源：https://example.com/a' };
    const result = await executeArticle(opts, prepareArticle(opts), egoFixtureDriver(egoFixtureTask(f)), f.store);
    assert.equal(result.error_code, 'EXTERNAL_LINK_POSITION_LOST', JSON.stringify(result));
    assert.equal(result.status, 'unverified');
    assert.equal(result.diagnostic.save_stage, 'links');
    assert.match(f.records[0].html, /来源：https:\/\/example.com\/a/);
  } finally { await f.context.close(); }
});

test('受控页面：Ego 上传被拒绝时记录待回查，再运行不二次上传', async () => {
  const f = await fixture({ autoDraft: true, egoDraft: true, egoMedia: true, dedicatedDraftPage: true, nativeDraftCards: true, uploadFailureAt: 2 });
  try {
    const opts = { account: 'fixture_account', draft: true, contentFile: join(dir, 'ego-media.md') };
    const input = prepareArticle(opts);
    const driver = egoFixtureDriver(egoFixtureTask(f));
    const result = await executeArticle(opts, input, driver, f.store);
    assert.equal(result.error_code, 'IMAGE_UPLOAD_FAILED', JSON.stringify(result));
    assert.equal(result.status, 'unverified');
    assert.equal((await executeArticle(opts, input, driver, f.store)).error_code, 'RECONCILIATION_REQUIRED');
    assert.equal(f.uploads, 2);
    assert.equal(f.records.length, 1);
    assert.match(f.records[0].html, /第一张/);
    assert.doesNotMatch(f.records[0].html, /TTOPSIMG/);
    assert.ok(f.draftRequests.every(request => !request.content.includes('TTOPSIMG')));
  } finally { await f.context.close(); }
});

test('受控页面：旧图注版本成功、当前版本 7050 时停止，回查同一草稿', async () => {
  const f = await fixture({ autoDraft: true, egoDraft: true, egoMedia: true, dedicatedDraftPage: true, nativeDraftCards: true, rejectSecondCaption: true });
  try {
    const opts = { account: 'fixture_account', draft: true, contentFile: join(dir, 'ego-media.md') };
    const result = await executeArticle(opts, prepareArticle(opts), egoFixtureDriver(egoFixtureTask(f)), f.store);
    assert.equal(result.error_code, 'DRAFT_SAVE_REJECTED', JSON.stringify(result));
    assert.match(result.message, /7050/);
    assert.equal(result.diagnostic.save_stage, 'caption_2');
    assert.equal(result.diagnostic.lookup.found, true);
    assert.equal(result.diagnostic.lookup.reopened, true);
    assert.deepEqual(result.diagnostic.lookup.persisted, { body_images: 2, filled_captions: 1, current_stage_matches: false });
    assert.equal(f.uploads, 2);
    const [older, current] = f.draftRequests.slice(-2);
    assert.equal(older.pgc_id, current.pgc_id);
    assert.doesNotMatch(older.content, /<figcaption>图2<\/figcaption>/);
    assert.match(current.content, /<figcaption>图2<\/figcaption>/);
  } finally { await f.context.close(); }
});

test('受控页面：Ego 等待当前图片完成上传和保存，再填写图注并处理下一张', async () => {
  let startFirst, releaseFirst;
  const firstStarted = new Promise(resolve => { startFirst = resolve; });
  const firstUpload = new Promise(resolve => { releaseFirst = resolve; });
  const f = await fixture({
    autoDraft: true, egoDraft: true, egoMedia: true, dedicatedDraftPage: true, nativeDraftCards: true,
    waitForUpload: number => {
      if (number !== 1) return;
      startFirst();
      return firstUpload;
    },
  });
  try {
    const opts = { account: 'fixture_account', draft: true, contentFile: join(dir, 'ego-gallery.md') };
    const task = egoFixtureTask(f);
    const run = executeArticle(opts, prepareArticle(opts), egoFixtureDriver(task), f.store);
    await Promise.race([firstStarted, run.then(result => { assert.fail(JSON.stringify(result)); })]);
    assert.equal(f.uploads, 1);
    assert.deepEqual(task.pasted, ['纯图草稿验收']);
    assert.equal(f.draftRequests.length, 0);
    releaseFirst();
    const result = await run;
    assert.equal(result.status, 'draft_saved', JSON.stringify(result));
    assert.equal(f.uploads, 2);
    assert.match(f.draftRequests[0].content, /<figcaption><\/figcaption>/);
    assert.match(f.draftRequests[1].content, /<figcaption>首图说明<\/figcaption>/);
    assert.doesNotMatch(f.draftRequests[1].content, /tos-fixture\/image-2/);
    assert.deepEqual(task.pasted, ['纯图草稿验收', '首图说明', '图二说明']);
    assert.deepEqual([...f.records[0].html.matchAll(/web_uri="([^"]+)/g)].map(match => match[1]),
      ['tos-fixture/image-1', 'tos-fixture/image-2']);
    assert.ok(f.draftRequests.every(request => !request.content.includes('TTOPSIMG')));
  } finally { releaseFirst(); await f.context.close(); }
});

test('受控页面：Ego 图片落到错误段落时立即停下，不填写图注或下一张', async () => {
  const f = await fixture({ autoDraft: true, egoDraft: true, egoMedia: true, dedicatedDraftPage: true, nativeDraftCards: true, misplaceImage: true });
  try {
    const opts = { account: 'fixture_account', draft: true, contentFile: join(dir, 'ego-caption.md') };
    const task = egoFixtureTask(f);
    const result = await executeArticle(opts, prepareArticle(opts), egoFixtureDriver(task), f.store);
    assert.equal(result.error_code, 'IMAGE_ORDER_CHANGED', JSON.stringify(result));
    assert.equal(result.status, 'unverified');
    assert.equal(f.uploads, 1);
    assert.equal(task.pasted.length, 2);
  } finally { await f.context.close(); }
});

test('受控页面：Ego 在段落末尾定位，第二张图留在段落和小标题之间', async () => {
  const f = await fixture({ autoDraft: true, egoDraft: true, egoMedia: true, dedicatedDraftPage: true, nativeDraftCards: true, headingRangeDrift: true });
  try {
    const opts = { account: 'fixture_account', draft: true, contentFile: join(dir, 'ego-heading.md') };
    const driver = egoFixtureDriver(egoFixtureTask(f));
    const result = await executeArticle(opts, prepareArticle(opts), driver, f.store);
    assert.equal(result.status, 'draft_saved', JSON.stringify(result));
    const html = f.records[0].html;
    const paragraph = html.indexOf('<strong>四份附表</strong>');
    const image = html.indexOf('web_uri="tos-fixture/image-2"');
    const heading = html.indexOf('<h1>下一个小标题</h1>');
    assert.ok(paragraph >= 0 && paragraph < image && image < heading);
    assert.match(html, /第二张图说明<\/textarea>/);
  } finally { await f.context.close(); }
});

test('受控页面：Ego 草稿只保存第一段时不能通过回查，重跑不粘贴', async () => {
  const f = await fixture({ autoDraft: true, egoDraft: true, dedicatedDraftPage: true, nativeDraftCards: true, persistFirstParagraph: true });
  try {
    const task = egoFixtureTask(f);
    const opts = { account: 'fixture_account', draft: true, title: 'Ego 草稿全文不匹配', content: '第一段正文\n\n第二段正文' };
    const input = prepareArticle(opts);
    const driver = egoFixtureDriver(task);
    const result = await executeArticle(opts, input, driver, f.store);
    assert.equal(result.status, 'unverified', JSON.stringify(result));
    assert.equal(result.error_code, 'PERSISTENCE_UNVERIFIED');
    assert.equal(result.diagnostic.lookup.found, true);
    assert.equal(f.saves, 1);
    const repeat = await executeArticle(opts, input, driver, f.store);
    assert.equal(repeat.error_code, 'RECONCILIATION_REQUIRED');
    assert.equal(task.pasted.length, 2);
  } finally { await f.context.close(); }
});
test('受控页面：纯文本草稿经浏览器输入，重开后保留标题、分段和段内换行', async () => {
  const f = await fixture({ autoDraft: true, dedicatedDraftPage: true, nativeDraftCards: true, nativeTextDraft: true });
  try {
    const opts = { account: 'fixture_account', draft: true, format: 'text', title: '纯文本输入验收', content: '第一段 HTML <与> Markdown *字符*\r\n段内第二行\r\n\r\n第二段正文，保留末尾。\r\n' };
    const result = await executeArticle(opts, prepareArticle(opts), f.driver, f.store);
    assert.equal(result.status, 'draft_saved', JSON.stringify(result));
    assert.equal(result.verified, true);
    assert.equal(f.records[0].title, opts.title);
    assert.equal(f.saves, 1);
    assert.ok(f.requests.includes('/profile_v4/manage/draft'));
    const editor = f.driver.page.locator('[contenteditable]');
    assert.equal(await editor.getAttribute('data-native-text-input'), 'true');
    assert.equal(await editor.getAttribute('data-pasted'), null);
  } finally { await f.context.close(); }
});
test('受控页面：草稿请求被平台拒绝时显示错误码，重复运行只能回查', async () => {
  const f = await fixture({ autoDraft: true, dedicatedDraftPage: true, draftRejection: true });
  try {
    const opts = { account: 'fixture_account', draft: true, title: '自动保存示例', content: '示例正文' };
    const input = prepareArticle(opts);
    const result = await executeArticle(opts, input, f.driver, f.store);
    assert.equal(result.error_code, 'DRAFT_SAVE_REJECTED');
    assert.match(result.message, /7050/);
    assert.equal(result.status, 'unverified');
    const repeat = await executeArticle(opts, input, f.driver, f.store);
    assert.equal(repeat.error_code, 'RECONCILIATION_REQUIRED');
    assert.equal(f.requests.filter(path => path === '/mp/agw/article/publish').length, 1);
    assert.equal(f.saves, 0);
  } finally { await f.context.close(); }
});
test('受控页面：重复图片只上传一次，保持图文位置，封面独立上传', async () => {
  const f = await fixture();
  try {
    const opts = { account: 'fixture_account', draft: true, title: '图文草稿测试', contentFile: join(dir, 'article.md'), cover: join(dir, 'cover.png') };
    const input = prepareArticle(opts);
    const result = await executeArticle(opts, input, f.driver, f.store);
    assert.equal(result.status, 'draft_saved', JSON.stringify(result));
    assert.equal(f.uploads, 2); assert.equal(f.saves, 1);
    const manifest = f.store.read().manifest;
    assert.equal(manifest.images.length, 2);
    const body = await snapshot(f.driver.page);
    assert.ok(body.images[0].offset < body.images[1].offset);
    const repeated = await executeArticle(opts, input, f.driver, f.store);
    assert.equal(repeated.success, true); assert.equal(f.saves, 1);
    const third = await executeArticle(opts, input, f.driver, f.store);
    assert.equal(third.success, true, JSON.stringify(third));
    assert.ok(f.store.read().manifest);
    assert.equal(f.uploads, 2);
  } finally { await f.context.close(); }
});
test('受控页面：拒绝恢复的旧草稿时，标题、正文和图片保持原样', async () => {
  for (const record of [
    { title: '旧标题', html: '<p>旧正文</p>' },
    { title: '', html: '<p>旧正文</p>' },
    { title: '', html: '<img src="https://mp.toutiao.com/fixture-image/one.png">' },
  ]) {
    const f = await fixture({ restoredRecord: record });
    try {
      const opts = { account: 'fixture_account', draft: true, title: '新文章标题', content: '新正文' };
      await assert.rejects(f.driver.prepare(prepareArticle(opts)), { code: 'EDITOR_NOT_EMPTY' });
      assert.equal(await f.driver.page.locator('textarea').inputValue(), record.title);
      assert.equal(await f.driver.page.locator('[contenteditable]').innerHTML(), record.html);
      assert.equal(f.saves, 0);
    } finally { await f.context.close(); }
  }
});
test('受控页面：草稿列表延迟加载时，不把旧作品列表当作空草稿箱', async () => {
  const f = await fixture({ listDelay: 250, initialRecords: [
    { id: '9001', title: '已发布的另一篇', html: '<p>正文</p>', status: '已发布' },
    { id: '9002', title: '已有目标草稿', html: '<p>正文</p>', status: '草稿' },
  ] });
  try {
    const opts = { account: 'fixture_account', draft: true, title: '已有目标草稿', content: '正文' };
    const result = await executeArticle(opts, prepareArticle(opts), f.driver, f.store);
    assert.equal(result.status, 'unverified'); assert.equal(result.error_code, 'RECONCILIATION_REQUIRED');
    assert.equal(f.saves, 0);
    assert.ok(!f.requests.some(path => path === '/profile_v4/graphic/publish'));
  } finally { await f.context.close(); }
});
test('受控页面：列表缺少切换完成证据时不编辑', async () => {
  const f = await fixture({ missingViewEvidence: true });
  try {
    const opts = { account: 'fixture_account', draft: true, title: '视图不明测试', content: '正文' };
    const result = await executeArticle(opts, prepareArticle(opts), f.driver, f.store);
    assert.equal(result.error_code, 'LIST_VIEW_UNVERIFIED'); assert.equal(f.saves, 0);
    assert.ok(!f.requests.some(path => path === '/profile_v4/graphic/publish'));
  } finally { await f.context.close(); }
});
test('受控页面：独立草稿页只读取页内状态，保存后识别目标记录', async () => {
  const manualDraft = { id: '9001', title: '手动保存的草稿', html: '<p>保留内容</p>', status: '草稿' };
  const f = await fixture({ dedicatedDraftPage: true, nativeDraftCards: true, initialRecords: [manualDraft] });
  try {
    const opts = { account: 'fixture_account', draft: true, title: '旧作品行', content: '示例正文' };
    const input = prepareArticle(opts);
    assert.deepEqual(await findArticleRecord(f.context, input, null, 'draft_save'), { record: null, complete: true });
    const result = await executeArticle(opts, input, f.driver, f.store);
    assert.equal(result.status, 'draft_saved', JSON.stringify(result));
    assert.equal(result.verified, true);
    assert.equal(f.saves, 1);
    assert.deepEqual(f.records[0], manualDraft);
    assert.ok(f.requests.includes('/profile_v4/manage/draft'));
  } finally { await f.context.close(); }
});
test('受控页面：草稿卡片缺少编辑入口时不能确认保存', async () => {
  const f = await fixture({ dedicatedDraftPage: true, nativeDraftCards: true, missingEdit: true });
  try {
    const opts = { account: 'fixture_account', draft: true, title: '待重开的草稿', content: '正文' };
    const result = await executeArticle(opts, prepareArticle(opts), f.driver, f.store);
    assert.equal(result.error_code, 'PERSISTENCE_UNVERIFIED');
    assert.equal(f.saves, 1);
    assert.equal(f.requests.filter(path => path === '/profile_v4/graphic/publish').length, 1);
  } finally { await f.context.close(); }
});
test('受控页面：独立草稿页只有页外的空状态时不编辑', async () => {
  const f = await fixture({ dedicatedDraftPage: true, missingViewEvidence: true });
  try {
    const opts = { account: 'fixture_account', draft: true, title: '空状态待核对', content: '正文' };
    const result = await executeArticle(opts, prepareArticle(opts), f.driver, f.store);
    assert.equal(result.error_code, 'LIST_VIEW_UNVERIFIED');
    assert.equal(f.saves, 0);
    assert.ok(f.requests.includes('/profile_v4/manage/draft'));
    assert.ok(!f.requests.some(path => path === '/profile_v4/graphic/publish'));
  } finally { await f.context.close(); }
});
test('受控页面：段落、词间空格、标题层级或代码缩进变化不能通过校验', async () => {
  const f = await fixture();
  try {
    await f.driver.page.goto('https://mp.toutiao.com/profile_v4/graphic/publish');
    for (const [expected, changed] of [
      ['<p>甲</p><p>乙</p>', '<p>甲乙</p>'],
      ['<p>hello world</p>', '<p>helloworld</p>'],
      ['<p>hello<span> </span>world</p>', '<p>helloworld</p>'],
      ['<h2>标题</h2>', '<p>标题</p>'],
      ['<pre><code>if ready:\n    publish()\nsave()</code></pre>', '<pre><code>if ready:\n    publish()\n    save()</code></pre>'],
      ['<pre><code>const text = "e\u0301";</code></pre>', '<pre><code>const text = "é";</code></pre>'],
    ]) {
      await f.driver.page.locator('[contenteditable]').evaluate((el, html) => { el.innerHTML = html; }, expected);
      const manifest = await snapshot(f.driver.page);
      assert.equal(matchesSnapshot(manifest, manifest), true, '未修改的正文必须通过，避免反例虚假通过');
      await f.driver.page.locator('[contenteditable]').evaluate((el, html) => { el.innerHTML = html; }, changed);
      assert.equal(matchesSnapshot(await snapshot(f.driver.page), manifest), false, expected);
    }
  } finally { await f.context.close(); }
});
test('受控页面：等价段落和内联标签不误报正文不一致', async () => {
  const f = await fixture();
  try {
    await f.driver.page.goto('https://mp.toutiao.com/profile_v4/graphic/publish');
    await f.driver.page.locator('[contenteditable]').evaluate(el => { el.innerHTML = '<p><strong>甲</strong> <em>乙</em></p>\n<p>第二段</p>'; });
    const manifest = await snapshot(f.driver.page);
    await f.driver.page.locator('[contenteditable]').evaluate(el => { el.innerHTML = '<div><b>甲</b><span> </span><i>乙</i></div><div>第二段</div>'; });
    assert.equal(matchesSnapshot(await snapshot(f.driver.page), manifest), true);
  } finally { await f.context.close(); }
});
test('受控页面：保存提示出现但无平台记录仍为 unverified', async () => {
  const f = await fixture({ noPersistence: true });
  try {
    const opts = { account: 'fixture_account', draft: true, title: '未落库测试', content: '正文' };
    const input = prepareArticle(opts);
    const result = await executeArticle(opts, input, f.driver, f.store);
    assert.equal(result.status, 'unverified'); assert.equal(result.success, false);
    await executeArticle(opts, input, f.driver, f.store);
    assert.equal(f.saves, 1);
  } finally { await f.context.close(); }
});
test('受控页面：没有草稿按钮时不改走发布', async () => {
  const f = await fixture({ missingSave: true });
  try {
    const opts = { account: 'fixture_account', draft: true, title: '缺少入口测试', content: '正文' };
    const result = await executeArticle(opts, prepareArticle(opts), f.driver, f.store);
    assert.equal(result.error_code, 'DRAFT_SAVE_UNAVAILABLE');
    assert.equal(result.success, false); assert.equal(f.saves, 0);
  } finally { await f.context.close(); }
});
test('受控页面：有 ID 和成功提示但重新打开的正文不一致时不能成功', async () => {
  const f = await fixture({ tamperPersisted: true });
  try {
    const opts = { account: 'fixture_account', draft: true, title: '正文不一致测试', content: '应当完整保存的文章正文' };
    const input = prepareArticle(opts);
    const result = await executeArticle(opts, input, f.driver, f.store);
    assert.equal(result.success, false); assert.equal(result.status, 'unverified');
    await executeArticle(opts, input, f.driver, f.store);
    assert.equal(f.saves, 1);
  } finally { await f.context.close(); }
});
test('受控页面：上传失败后既不保存也不发布', async () => {
  const f = await fixture({ uploadFailure: true });
  try {
    const opts = { account: 'fixture_account', draft: true, title: '上传失败测试', contentFile: join(dir, 'article.md') };
    const result = await executeArticle(opts, prepareArticle(opts), f.driver, f.store);
    assert.equal(result.error_code, 'IMAGE_UPLOAD_FAILED', JSON.stringify(result));
    assert.equal(f.saves, 0);
  } finally { await f.context.close(); }
});
test('受控页面：正式提交回查为审核中，不能称为公开发布', async () => {
  const f = await fixture();
  try {
    const opts = { account: 'fixture_account', publish: true, title: '审核状态测试', content: '正式路径仅在受控页面模拟' };
    const result = await executeArticle(opts, prepareArticle(opts), f.driver, f.store);
    assert.equal(result.status, 'submitted_for_review', JSON.stringify(result));
    assert.equal(result.success, true); assert.equal(f.saves, 1);
  } finally { await f.context.close(); }
});
test('受控页面：快照检测正文图片被移动到末尾', async () => {
  const f = await fixture();
  try {
    await f.driver.page.goto('https://mp.toutiao.com/profile_v4/graphic/publish');
    await f.driver.page.locator('[contenteditable]').evaluate(el => { el.innerHTML = '前<img src="https://mp.toutiao.com/fixture-image/one.png">后'; });
    await f.driver.page.waitForFunction(() => document.querySelector('[contenteditable] img').naturalWidth > 0);
    const first = await snapshot(f.driver.page);
    await f.driver.page.locator('[contenteditable]').evaluate(el => { el.append(el.querySelector('img')); });
    const moved = await snapshot(f.driver.page);
    assert.notEqual(first.images[0].offset, moved.images[0].offset);
  } finally { await f.context.close(); }
});
test('离线 HTML 实际渲染标题与本地图片，不请求外部资源或执行脚本', async () => {
  const context = await browser.newContext();
  const external = [];
  await context.route('**/*', route => { external.push(route.request().url()); return route.abort(); });
  const page = await context.newPage();
  try {
    const input = prepareArticle({ dryRun: true, title: '离线渲染测试', contentFile: join(dir, 'article.md'), cover: join(dir, 'cover.png') });
    await page.setContent(buildPreviewHtml(input));
    await page.waitForFunction(() => [...document.images].every(image => image.complete && image.naturalWidth > 0));
    assert.equal(await page.locator('h1').textContent(), '离线渲染测试');
    assert.equal(await page.locator('img').count(), 3);
    assert.equal(await page.locator('script').count(), 0);
    assert.deepEqual(external, []);
  } finally { await context.close(); }
});
