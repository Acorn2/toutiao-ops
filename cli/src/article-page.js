import { join } from 'node:path';
import { chmodSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { assertBoundIdentity } from './auth-guard.js';
import { getScreenshotDir } from './browser.js';
import { ensurePrivateDir } from './account-store.js';
import { EDITOR, snapshot, matchesSnapshot, inspectContent, contentSnapshot, mediaKey, findArticleRecord, recordId } from './article-records.js';
import { escapeHtml, renderTextParagraphs, validateImage } from './article-input.js';
import { fail, errorCode } from './errors.js';

const PUBLISH_PAGE = 'https://mp.toutiao.com/profile_v4/graphic/publish';
const TITLE = 'textarea[placeholder*="标题"], input[placeholder*="标题"]';
const PANEL = '[role="dialog"]:visible, .byte-drawer-wrapper:visible, .upload-image-panel:visible';
const DRAFT_STATUS = '.footer-draft-save .footer-tip-save';
const DRAFT_BUTTON = /^(保存草稿|存草稿|存为草稿)$/;
const DRAFT_EDIT_INTERVAL_MS = 2700;

function syncControl(page) {
  return page.getByRole('checkbox', { name: /同时发布微头条|发布得更多收益/ }).or(
    page.locator('.form-tuwen_wtt_trans').filter({ has: page.getByText('同时发布微头条', { exact: true }) })
      .locator('input[type="checkbox"]'),
  );
}

export async function pasteHtml(page, html, text) {
  await page.locator(EDITOR).first().evaluate((editor, value) => {
    editor.focus();
    const data = new DataTransfer();
    data.setData('text/html', value.html);
    data.setData('text/plain', value.text);
    editor.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  }, { html, text });
}

async function enterTextParagraphs(page, paragraphs) {
  // Use browser editing input so ProseMirror processes the text and line breaks itself.
  for (const [paragraphIndex, paragraph] of paragraphs.entries()) {
    if (paragraphIndex > 0) await page.keyboard.press('Enter');
    for (const [lineIndex, line] of paragraph.split('\n').entries()) {
      if (lineIndex > 0) await page.keyboard.press('Shift+Enter');
      if (line) await page.keyboard.insertText(line.replaceAll('\r', ' '));
    }
  }
}

async function fillDraftTitle(field, title) {
  const characters = [...title];
  const lengths = new Set([Math.ceil(characters.length / 3), Math.ceil(characters.length * 2 / 3), characters.length]);
  // The desktop editor debounces changes and defers the first saves of a new draft.
  // Let each title edit settle before entering the body.
  for (const length of lengths) {
    await field.fill(characters.slice(0, length).join(''));
    await new Promise(resolve => setTimeout(resolve, DRAFT_EDIT_INTERVAL_MS));
  }
}

function watchDraftRejection(page) {
  let rejection;
  // Observe the editor's own request without making, replaying, or reading its payload.
  return page.waitForResponse(async response => {
    const url = new URL(response.url());
    if (url.origin !== new URL(PUBLISH_PAGE).origin || url.pathname !== '/mp/agw/article/publish' || response.request().method() !== 'POST') return false;
    const data = await response.json().catch(() => null);
    const code = data?.code ?? data?.errno ?? data?.status_code;
    if (/^-?\d{1,9}$/.test(code) && Number(code) !== 0) rejection = `平台错误码 ${code}`;
    else if (!response.ok()) rejection = `HTTP ${response.status()}`;
    return !!rejection;
  }, { timeout: 0 }).then(() => rejection, () => null);
}

async function selectMarker(page, marker) {
  const found = await page.locator(EDITOR).first().evaluate((editor, value) => {
    const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode;
      const index = node.textContent.indexOf(value);
      if (index < 0) continue;
      editor.focus();
      const range = document.createRange();
      range.setStart(node, index); range.setEnd(node, index + value.length);
      const selection = window.getSelection();
      selection.removeAllRanges(); selection.addRange(range);
      return true;
    }
    return false;
  }, marker);
  if (!found) fail('IMAGE_POSITION_LOST', '编辑器未保留图片定位文本，停止操作以避免乱序插图');
}

async function manualChallenge(page) {
  if (await page.locator('iframe[src*="captcha"], [class*="captcha"]:visible').count()
    || await page.getByText(/^(请完成安全验证|请完成验证|安全验证|拖动滑块完成验证)$/).count()) {
    fail('MANUAL_VERIFICATION_REQUIRED', '平台要求人工安全验证；已停止操作，不自动绕过');
  }
  if (/\/auth\/|login/.test(new URL(page.url()).pathname)) fail('AUTH_REQUIRED', '登录态已过期，需人工扫码');
}

async function verifyUploadFile(image) {
  if (validateImage(image.path).sha256 !== image.sha256) fail('INPUT_CHANGED', '图片文件在校验后发生变化，停止上传');
}

async function waitUploadedPanel(page, previousSources) {
  try {
    await page.waitForFunction(selector => {
      const panels = [...document.querySelectorAll(selector.replaceAll(':visible', ''))].filter(el => el.getBoundingClientRect().width > 0);
      const panel = panels.at(-1);
      if (!panel) return false;
      if (/上传失败|上传错误/.test(panel.innerText)) return true;
      return /上传成功|上传完成/.test(panel.innerText) && !/上传中|正在上传/.test(panel.innerText) && [...panel.querySelectorAll('img')].some(img => /^https:\/\//.test(img.src) && img.complete && img.naturalWidth > 0);
    }, PANEL, { timeout: 45000 });
  } catch { fail('IMAGE_UPLOAD_TIMEOUT', '图片上传未确认完成，停止保存/发布'); }
  const panel = page.locator(PANEL).last();
  if (/上传失败|上传错误/.test(await panel.innerText())) fail('IMAGE_UPLOAD_FAILED', '平台报告图片上传失败');
  const sources = [...new Set(await panel.locator('img').evaluateAll(images => images.filter(img => /^https:\/\//.test(img.src) && img.complete && img.naturalWidth > 0).map(img => img.currentSrc || img.src)))];
  const fresh = sources.filter(src => !previousSources.includes(src));
  const candidates = fresh.length ? fresh : sources;
  if (candidates.length !== 1) fail('UPLOAD_PREVIEW_AMBIGUOUS', '无法唯一确认本次上传的远程图片预览，停止提交');
  return { panel, source: candidates[0] };
}

export class ArticlePage {
  constructor(context, page, account) {
    this.context = context; this.page = page; this.account = account;
    this.listVerified = false; this.manifest = null;
  }
  async assertIdentity() { await assertBoundIdentity(this.context, this.account); }
  async findRecord(input, entry, action) {
    this.listVerified = false;
    this.lastLookup = { kind: action, complete: false };
    try {
      const result = await findArticleRecord(this.context, input, entry, action);
      this.listVerified = result.complete;
      this.lastLookup = { kind: action, complete: result.complete, found: !!result.record, ambiguous: !!result.record?.ambiguous,
        article_id: result.record?.id || null, status: result.record?.status || null, content_matches: !!result.record?.contentMatches };
      return result.record;
    } catch (error) { this.lastLookup.error_code = errorCode(error); throw error; }
  }
  async prepare(input, action) {
    const page = this.page;
    await page.goto(PUBLISH_PAGE, { waitUntil: 'domcontentloaded' });
    await manualChallenge(page);
    const title = page.locator(TITLE).first();
    await title.waitFor();
    const maxLength = await title.getAttribute('maxlength');
    if (maxLength && Number(maxLength) > 0 && input.title.length > Number(maxLength)) fail('PLATFORM_TITLE_LIMIT', '标题超过当前页面 maxlength，停止操作；不会截断');
    const editor = page.locator(EDITOR).first();
    await editor.waitFor();
    const text = await editor.evaluate(el => {
      const body = el.cloneNode(true);
      if (el.classList.contains('ProseMirror')) {
        const placeholder = body.querySelector('p > span.syl-placeholder.ProseMirror-widget');
        if (placeholder?.textContent === '请输入正文') placeholder.remove();
      }
      return body.textContent.trim();
    });
    if (recordId(page.url()) || (await title.inputValue()).trim() || text
      || await editor.locator('img, video, audio, iframe, table, pre').count() || await page.locator('[class*="cover"] img').count()) {
      fail('EDITOR_NOT_EMPTY', '编辑器恢复了已有标题、正文或图片；停止填写，请人工检查草稿');
    }
    this.autoDraftSave = false;
    if (action === 'draft_save') {
      const save = page.getByRole('button', { name: DRAFT_BUTTON });
      const automatic = page.locator(DRAFT_STATUS).filter({ hasText: /^(草稿将自动保存|草稿保存中\.{3})$/ });
      try { await save.or(automatic).waitFor(); }
      catch { fail('DRAFT_SAVE_UNAVAILABLE', '未识别到唯一的保存草稿按钮或平台自动保存状态'); }
      this.autoDraftSave = await save.count() === 0 && page.url() === PUBLISH_PAGE && await automatic.count() === 1;
      if (await save.count() !== 1 && !this.autoDraftSave) fail('DRAFT_SAVE_UNAVAILABLE', '未识别到唯一的草稿保存方式');
      if (this.autoDraftSave) this.draftRejection = watchDraftRejection(page);
    }
    const sync = syncControl(page);
    try { await sync.waitFor({ state: 'attached' }); }
    catch { fail('SYNC_CONTROL_UNAVAILABLE', '未能唯一确认微头条同步开关'); }
    await sync.uncheck();
    const coverName = input.coverMode === 'single' ? /^单图$/ : /^无封面$/;
    const coverRadio = page.getByRole('radio', { name: coverName });
    const coverLabel = page.locator('label.byte-radio').filter({ hasText: coverName, has: page.locator('input[type="radio"]') });
    await coverRadio.or(coverLabel).first().waitFor();
    const coverMode = await coverRadio.count() === 1 ? coverRadio : coverLabel.locator('input[type="radio"]');
    if (await coverMode.count() !== 1) fail('COVER_CONTROL_UNAVAILABLE', '未能唯一确认封面选项');
    await manualChallenge(page);
    if (this.autoDraftSave) await fillDraftTitle(title, input.title);
    else await title.fill(input.title);
    if (await title.inputValue() !== input.title) fail('TITLE_CHANGED', '平台修改了输入标题，停止操作');
    await editor.focus();
    let expectedHtml = input.html;
    if (this.autoDraftSave && input.textParagraphs) {
      // A file's closing newline should not create a hard break at the editor caret.
      const paragraphs = input.textParagraphs.map(paragraph => paragraph.replace(/\r?\n\s*$/, ''));
      await enterTextParagraphs(page, paragraphs);
      expectedHtml = renderTextParagraphs(paragraphs);
    } else await pasteHtml(page, input.html, input.content);
    const expected = contentSnapshot(await page.evaluate(inspectContent, expectedHtml));
    if (!matchesSnapshot(await snapshot(page), expected)) fail('EDITOR_CONTENT_MISMATCH', '编辑器未完整接收段落、标题、代码与链接；停止提交');
    const uploaded = new Map();
    const orderedKeys = [];
    for (const image of input.images) {
      await verifyUploadFile(image);
      await selectMarker(page, image.marker);
      let expectedSource = uploaded.get(image.sha256);
      if (uploaded.has(image.sha256)) {
        const src = uploaded.get(image.sha256);
        await pasteHtml(page, `<img src="${escapeHtml(src)}" alt="${escapeHtml(image.alt)}">`, '');
      } else {
        // Delete only the selected marker; the editor retains the insertion caret for its image toolbar.
        await page.keyboard.press('Backspace');
        await page.getByRole('button', { name: /^(图片|插入图片)$/ }).click();
        const panel = page.locator(PANEL).last();
        await panel.waitFor();
        const previousSources = await panel.locator('img').evaluateAll(images => images.map(img => img.src));
        await panel.locator('input[type="file"][accept*="image"]').first().setInputFiles(image.path);
        const uploadedPanel = await waitUploadedPanel(page, previousSources);
        expectedSource = uploadedPanel.source;
        await uploadedPanel.panel.getByRole('button', { name: /^(确定|插入)$/ }).click();
      }
      const expectedCount = orderedKeys.length + 1;
      try {
        await page.waitForFunction(({ selector, count, marker }) => {
          const editor = document.querySelector(selector);
          const images = [...(editor?.querySelectorAll('img') || [])];
          return !editor?.textContent.includes(marker) && images.length === count && images.every(img => /^https:\/\//.test(img.src) && img.complete && img.naturalWidth > 0);
        }, { selector: EDITOR, count: expectedCount, marker: image.marker }, { timeout: 45000 });
      } catch { fail('IMAGE_UPLOAD_FAILED', '正文插图未完成或重复插入，停止提交'); }
      const sources = await editor.locator('img').evaluateAll(images => images.map(img => img.currentSrc || img.src));
      if (sources.slice(0, -1).some((src, i) => mediaKey(src) !== orderedKeys[i])) fail('IMAGE_ORDER_CHANGED', '编辑器改变了已插入图片顺序，停止提交');
      const src = sources.at(-1);
      if (mediaKey(src) !== mediaKey(expectedSource)) fail('IMAGE_CONTENT_MISMATCH', '正文插图与本次上传预览不一致');
      uploaded.set(image.sha256, src);
      orderedKeys.push(mediaKey(src));
      expectedHtml = expectedHtml.replace(image.marker, `<img src="${escapeHtml(src)}" alt="${escapeHtml(image.alt)}">`);
    }
    let coverKey = null;
    if (!(await coverMode.isChecked())) {
      if (await coverMode.isVisible()) await coverMode.check();
      else await coverLabel.click();
      if (!(await coverMode.isChecked())) fail('COVER_CONTROL_UNAVAILABLE', '未确认封面选项已选中');
    }
    if (input.cover) {
      await verifyUploadFile(input.cover);
      await page.locator('[class*="cover"] [class*="add"], [class*="cover"] [class*="upload"]').first().click();
      const panel = page.locator(PANEL).last();
      await panel.waitFor();
      const previousSources = await panel.locator('img').evaluateAll(images => images.map(img => img.src));
      const fileInput = panel.locator('input[type="file"][accept*="image"]').first();
      if (await fileInput.count()) await fileInput.setInputFiles(input.cover.path);
      else {
        const [chooser] = await Promise.all([page.waitForEvent('filechooser'), panel.getByText('本地上传', { exact: true }).click()]);
        await chooser.setFiles(input.cover.path);
      }
      const uploadedPanel = await waitUploadedPanel(page, previousSources);
      coverKey = mediaKey(uploadedPanel.source);
      await uploadedPanel.panel.getByRole('button', { name: /^(确定|插入)$/ }).click();
      try {
        await page.waitForFunction(src => [...document.querySelectorAll('[class*="cover"] img')].some(img => {
          try { return new URL(img.currentSrc || img.src).href === new URL(src).href && img.complete && img.naturalWidth > 0; } catch { return false; }
        }), uploadedPanel.source, { timeout: 45000 });
      } catch { fail('COVER_UPLOAD_FAILED', '未确认封面完成上传，停止提交'); }
      if (!coverKey) fail('COVER_UPLOAD_FAILED', '无法读取封面记录');
    }
    // Explicitly prevent the old implicit cross-post to a micro post.
    if (input.settings.firstPublish) await page.getByRole('checkbox', { name: /头条首发/ }).check();
    if (input.settings.collection) {
      await page.getByText('添加至合集', { exact: true }).click();
      const dialog = page.locator(PANEL).last();
      await dialog.getByText(input.settings.collection, { exact: true }).click();
      await dialog.getByRole('button', { name: /^(确定|确认)$/ }).click();
    }
    const labels = { '个人观点': '个人观点，仅供参考', '虚构演绎': '虚构演绎，故事经历', '投资观点': '投资观点，仅供参考', '健康医疗': '健康医疗分享，仅供参考' };
    for (const declaration of (input.settings.declaration || '').split(',').map(d => d.trim()).filter(Boolean)) {
      await page.getByRole('checkbox', { name: labels[declaration] || declaration, exact: true }).check();
    }
    const expectedFinal = contentSnapshot(await page.evaluate(inspectContent, expectedHtml));
    const manifest = { schema_version: 2, contentHash: expectedFinal.contentHash, linksHash: expectedFinal.linksHash,
      images: expectedFinal.images.map(({ key }) => ({ key })), coverKey };
    if (!matchesSnapshot(await snapshot(page), manifest)) fail('EDITOR_CONTENT_MISMATCH', '正文结构、代码、链接或插图顺序与输入不一致，停止提交');
    this.manifest = manifest;
    return manifest;
  }
  async checkReady(input) {
    await manualChallenge(this.page);
    if (await this.page.locator(TITLE).first().inputValue() !== input.title || !matchesSnapshot(await snapshot(this.page), this.manifest)) fail('EDITOR_CONTENT_CHANGED', '提交前编辑器内容发生变化');
    if (await syncControl(this.page).isChecked()) fail('SYNC_ENABLED', '微头条同步开关仍然开启，停止提交');
    if (await this.page.getByText(/^(上传失败|正在上传|上传中)$/).count()) fail('UPLOAD_INCOMPLETE', '仍有未完成或失败的上传');
    if (this.manifest.coverKey) {
      const images = await this.page.locator('[class*="cover"] img').evaluateAll(images => images.map(img => ({ src: img.currentSrc || img.src, ready: img.complete && img.naturalWidth > 0 })));
      if (!images.some(image => image.ready && mediaKey(image.src) === this.manifest.coverKey)) fail('COVER_UPLOAD_FAILED', '提交前封面缺失或尚未加载完成');
    }
  }
  async submit(action) {
    const page = this.page;
    await manualChallenge(page);
    if (action === 'draft_save') {
      if (this.autoDraftSave) {
        let rejection;
        try {
          rejection = await Promise.race([
            this.draftRejection,
            page.locator(DRAFT_STATUS).filter({ hasText: /^(草稿已保存|草稿保存成功|草稿已自动保存|保存成功)$/ }).waitFor({ timeout: 15000 }),
          ]);
        } catch { fail('SUBMISSION_UNCONFIRMED', '自动保存反馈待确认，将回查草稿记录'); }
        if (rejection) fail('DRAFT_SAVE_REJECTED', `头条拒绝保存草稿（${rejection}）。请核对头条后台提示与草稿箱。`);
        return;
      }
      const save = page.getByRole('button', { name: DRAFT_BUTTON });
      if (await save.count() !== 1) fail('DRAFT_SAVE_UNAVAILABLE', '找不到唯一的草稿保存按钮；不会改走正式发布');
      await save.click();
    } else {
      await page.getByRole('button', { name: /^预览并发布$/ }).click();
      await manualChallenge(page);
      await page.getByRole('button', { name: /^确认发布$/ }).click();
      const confirmation = page.getByRole('dialog').filter({ hasText: /是否.*发布|确定发布|确认发布/ });
      if (await confirmation.count()) await confirmation.getByRole('button', { name: /^(确定|确认)$/ }).click();
    }
    try {
      await Promise.any([
        page.getByText(/^(保存成功|草稿已保存|草稿保存成功|发布成功|已提交审核|提交成功)$/).first().waitFor({ timeout: 15000 }),
        page.waitForURL(url => url.pathname.includes('/manage/content/'), { timeout: 15000 }),
      ]);
    } catch { fail('SUBMISSION_UNCONFIRMED', '未观察到明确提交反馈，将回查平台记录；不会重复点击'); }
  }
  async diagnose(stage) {
    if (this.page.isClosed()) return { stage, screenshot: null, lookup: this.lastLookup || null };
    const dir = ensurePrivateDir(getScreenshotDir(this.account));
    const path = join(dir, `article-${randomUUID()}.png`);
    await this.page.screenshot({ path, mask: [this.page.locator('.information, .auth-avator-name, .auth-avator-img, [type="password"], [class*="qrcode"]')] });
    chmodSync(path, 0o600);
    return { stage, screenshot: path, lookup: this.lastLookup || null, message: '仅保存在本地；截图仍可能含文章内容，请勿提交仓库' };
  }
}
