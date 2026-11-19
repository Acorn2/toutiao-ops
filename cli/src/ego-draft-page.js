import { setTimeout as pause } from 'node:timers/promises';
import { MP_HOME, IDENTITY_LINK, inspectIdentityLink, verifyIdentity } from './auth-guard.js';
import { renderTextParagraphs } from './article-input.js';
import { CONTENT_PAGE, contentSnapshot, inspectContent, matchesSnapshot, recordId } from './article-records.js';
import { addEgoVisualProof, egoMediaParams, egoMediaProof, insertEgoImage, matchesEgoMedia, readEgoMedia, renderEgoHtml, setEgoCover, setEgoImageCaption } from './ego-article-media.js';
import { insertEgoExternalLinks } from './ego-article-links.js';
import { observeEgoDraftResponse, waitEgoDraftSave } from './ego-draft-save.js';
import { fail } from './errors.js';

const ORIGIN = new URL(MP_HOME).origin;
const EDITOR_PATH = '/profile_v4/graphic/publish';
const EDITOR_URL = `${ORIGIN}${EDITOR_PATH}`;
const DRAFT_MENU = '.management_tab .byte-menu-item a[href="/profile_v4/manage/draft"]';
const DRAFT_SCOPE = '.manage_draft-wrapper main .draft-page';
const DRAFT_CARD = '.article-draft-item.draft-item';
const TITLE = 'textarea[placeholder*="标题"], input[placeholder*="标题"]';
const BODY = '.ProseMirror[contenteditable="true"]';
const FOOTER = '.footer-draft-save .footer-tip-save';

async function checkChallenge(page) {
  const state = await page.evaluate(() => {
    const visible = element => element?.getBoundingClientRect().height > 0;
    const challenge = [...document.querySelectorAll('iframe[src*="captcha"], [class*="captcha"], [role="dialog"]')]
      .some(element => visible(element) && (element.matches('iframe[src*="captcha"], [class*="captcha"]') || /安全验证|完成验证/.test(element.innerText)));
    return { challenge, login: /\/auth\/|login/.test(location.pathname) };
  });
  if (state.challenge) fail('MANUAL_VERIFICATION_REQUIRED', '头条要求人工完成安全验证');
  if (state.login) fail('AUTH_REQUIRED', '请在该 Ego Profile 登录指定的头条号');
}

export async function verifyEgoIdentity(page, userId) {
  await page.goto(MP_HOME);
  await checkChallenge(page);
  try { await page.waitForSelector(IDENTITY_LINK, { state: 'attached', timeout: 15000 }); }
  catch {
    await checkChallenge(page);
    fail('IDENTITY_UNAVAILABLE', 'Ego 创作者后台未显示账号身份，请核对在线登录态');
  }
  const identity = await page.evaluate(inspectIdentityLink, IDENTITY_LINK);
  if (!identity) fail('IDENTITY_UNAVAILABLE', 'Ego 创作者后台未显示唯一的数字账号 ID');
  verifyIdentity(identity, { userId });
  return identity;
}

// Runs in the browser for both the pre-write list check and the post-save lookup.
function draftListState({ menu, scope, card, title }) {
  const active = document.querySelector(`${menu}.active`);
  const view = document.querySelector(scope);
  const list = view?.querySelector(':scope > .list');
  const total = view?.querySelector(':scope > .list-count')?.innerText.trim().match(/^共\s*(\d+)\s*条内容$/)?.[1];
  const visible = element => element?.getBoundingClientRect().height > 0 && getComputedStyle(element).visibility === 'visible';
  if (location.pathname !== '/profile_v4/manage/draft' || !visible(active) || !visible(view) || !list || total === undefined || view.getAttribute('aria-busy') === 'true') return null;
  const rows = [...list.children];
  const empty = view.querySelector(':scope > .byte-empty.no-content');
  if (total === '0') return rows.length === 0 && visible(empty) && empty.innerText.trim() === '暂无草稿' ? [] : null;
  const names = rows.map(row => row.matches(card) && visible(row) && row.querySelector('a.title')?.textContent.trim());
  if (visible(empty) || Number(total) !== rows.length || names.some(name => !name)) return null;
  return names.flatMap((name, index) => name === title ? [index + 1] : []);
}

async function readEditor(page) {
  return page.evaluate(({ title, body }) => {
    const titles = document.querySelectorAll(title);
    const bodies = document.querySelectorAll(body);
    return titles.length === 1 && bodies.length === 1 ? { title: titles[0].value, html: bodies[0].innerHTML } : null;
  }, { title: TITLE, body: BODY });
}

async function editorSnapshot(page, html) {
  return contentSnapshot(await page.evaluate(inspectContent, html));
}

async function matchesEditor(page, input, manifest) {
  const actual = await readEditor(page);
  if (actual?.title !== input.title) return false;
  if (!input.images.length) return matchesSnapshot(await editorSnapshot(page, actual.html), manifest);
  if (!manifest.egoMedia) return false;
  const media = await page.evaluate(readEgoMedia, egoMediaParams(input));
  const expected = manifest.egoMedia;
  const proof = egoMediaProof(media, input, expected.mode);
  if (!proof || !matchesSnapshot(await editorSnapshot(page, media.html), manifest)) return false;
  if (matchesEgoMedia(proof, expected)) return true;
  if (![...expected.images, ...expected.covers].some(item => item.visual)) return false;
  return matchesEgoMedia(await addEgoVisualProof(page, media, proof), expected);
}

export class EgoDraftPage {
  constructor(task, userId, { onTiming } = {}) {
    this.task = task;
    this.page = task.page('p1');
    this.userId = userId;
    this.editing = false;
    this.listVerified = false;
    this.lastLookup = null;
    this.onTiming = onTiming;
  }

  async measure(stage, work) {
    if (!this.onTiming) return work();
    const started = performance.now();
    try { return await work(); }
    finally { this.onTiming(stage, Math.round(performance.now() - started)); }
  }

  async confirmSave(stage, expected, needsId = false) {
    this.saveStage = stage;
    this.saveExpected = expected;
    const saved = await waitEgoDraftSave(this.observeDraftSave, { ...expected, draftId: this.draftId }).catch(async error => {
      if (error.code === 'SUBMISSION_UNCONFIRMED') await checkChallenge(this.page);
      throw error;
    });
    this.draftId = saved.draftId;
    if (needsId && !this.draftId) fail('DRAFT_ID_UNCONFIRMED', '没有确认本次自动保存的草稿 ID，停止写入并回查');
  }

  async assertIdentity() {
    if (!this.editing) return verifyEgoIdentity(this.page, this.userId);
    await checkChallenge(this.page);
    const identity = await this.page.evaluate(inspectIdentityLink, IDENTITY_LINK);
    if (identity) return verifyIdentity(identity, { userId: this.userId });
    this.identityPage ??= await this.task.newPage();
    await verifyEgoIdentity(this.identityPage, this.userId);
  }

  async findRecord(input, entry) {
    this.editing = false;
    this.listVerified = false;
    this.lastLookup = { kind: 'draft_save', complete: false };
    const page = this.page;
    await page.goto(CONTENT_PAGE);
    await checkChallenge(page);
    await page.waitForSelector(DRAFT_MENU, { state: 'visible', timeout: 15000 });
    await page.click(DRAFT_MENU, { label: '打开头条号草稿箱' });
    const selectors = { menu: DRAFT_MENU, scope: DRAFT_SCOPE, card: DRAFT_CARD, title: input.title };
    try { await page.waitForFunction(draftListState, selectors, { timeout: 20000 }); }
    catch { fail('LIST_VIEW_UNVERIFIED', '未确认 Ego 草稿箱已完成加载'); }
    await checkChallenge(page);
    const positions = await page.evaluate(draftListState, selectors);
    if (!positions) fail('LIST_VIEW_UNVERIFIED', 'Ego 草稿箱页面状态发生变化');
    this.listVerified = true;
    this.lastLookup = { kind: 'draft_save', complete: true, found: positions.length > 0, ambiguous: positions.length > 1, content_matches: false };
    if (positions.length > 1) return { ambiguous: true };
    if (!positions.length) return null;
    const record = { status: 'draft_saved', contentMatches: false };
    const manifest = entry?.manifest?.schema_version === 2 ? entry.manifest : null;
    const current = this.saveExpected?.title === input.title ? this.saveExpected : null;
    if (!manifest && !current) return record;
    const edit = `${DRAFT_SCOPE} > .list > ${DRAFT_CARD}:nth-child(${positions[0]}) a.op-button:text-is("编辑")`;
    const popup = page.waitForEvent('popup', { timeout: 8000 }).catch(() => null);
    const receipt = await page.click(edit, { label: '重开已保存的草稿' });
    const label = receipt?.popups?.[0]?.label;
    const saved = label ? this.task.page(label) : (await popup) || page;
    try { await saved.waitForURL(`${EDITOR_URL}*`, { timeout: 8000 }); }
    catch { return record; }
    await checkChallenge(saved);
    const url = new URL(await saved.url());
    const id = recordId(url);
    if (url.origin !== ORIGIN || url.pathname !== EDITOR_PATH || !id || (current && this.draftId && id !== this.draftId)) return record;
    Object.assign(record, { id, url: `${EDITOR_URL}?pgc_id=${id}` });
    this.reopenedPage = saved;
    this.lastLookup.reopened = true;
    if (!manifest) {
      await this.readPartialDraft(saved, input, current);
      return record;
    }
    if (manifest.egoExternalLinkCount === undefined && input.html.includes('<a ')) {
      const rendered = await saved.evaluate(renderEgoHtml, { html: input.html, markers: egoMediaParams(input).markers });
      if (rendered.links.length) {
        this.lastLookup.external_links_need_update = true;
        return record;
      }
    }
    // A nonempty editor can be an intermediate hydration state. Recheck the full manifest.
    for (let attempt = 0; attempt < 12; attempt++) {
      if (await matchesEditor(saved, input, manifest)) {
        record.contentMatches = true;
        break;
      }
      await pause(1000);
    }
    this.lastLookup.content_matches = record.contentMatches;
    return record;
  }

  async readPartialDraft(page, input, expected) {
    const ready = await page.waitForFunction(({ titleField, body, title }) => {
      const editor = document.querySelector(body);
      return document.querySelector(titleField)?.value === title && !!editor &&
        (editor.textContent.trim() || editor.querySelector('img,hr,pre'));
    }, { titleField: TITLE, body: BODY, title: input.title }, { timeout: 5000 }).catch(() => false);
    if (!ready) return;
    const state = await page.evaluate(readEgoMedia, egoMediaParams(input));
    if (!state) return;
    this.lastLookup.persisted = {
      body_images: state.sources.length,
      filled_captions: state.sources.filter(source => source.caption.trim()).length,
      current_stage_matches: state.sources.length === expected.images.length && state.sources.every((source, index) =>
        source.uri?.replace(/^\/+/, '') === expected.images[index].uri && source.caption === expected.images[index].caption)
        && matchesSnapshot(await editorSnapshot(page, state.html), expected.snapshot),
    };
  }

  async prepare(input) {
    const page = this.page;
    await page.goto(EDITOR_URL);
    await checkChallenge(page);
    await page.waitForSelector(TITLE, { state: 'visible', timeout: 15000 });
    await page.waitForSelector(BODY, { state: 'visible', timeout: 15000 });
    await page.waitForSelector(FOOTER, { state: 'visible', timeout: 15000 });
    this.editing = true;
    await this.assertIdentity();
    const blank = await page.evaluate(({ title, body, footer }) => {
      const titles = document.querySelectorAll(title);
      const bodies = document.querySelectorAll(body);
      const editor = bodies[0]?.cloneNode(true);
      editor?.querySelectorAll('.syl-placeholder.ProseMirror-widget').forEach(node => node.remove());
      const max = titles[0]?.maxLength;
      return {
        empty: location.search === '' && titles.length === 1 && bodies.length === 1 && !titles[0].value && !editor?.textContent.trim()
          && !editor.querySelector('img,video,pre,table,iframe,audio') && !document.querySelector('[class*="cover"] img'),
        automatic: /^(草稿将自动保存|草稿保存中\.{3})$/.test(document.querySelector(footer)?.textContent.trim() || ''),
        max,
      };
    }, { title: TITLE, body: BODY, footer: FOOTER });
    if (!blank.empty) fail('EDITOR_NOT_EMPTY', '未确认 Ego 编辑器为空，停止填写');
    if (!blank.automatic) fail('DRAFT_SAVE_UNAVAILABLE', '未识别到头条自动保存状态');
    if (blank.max > 0 && input.title.length > blank.max) fail('PLATFORM_TITLE_LIMIT', '标题超过编辑器上限');
    const originalHtml = input.textParagraphs ? renderTextParagraphs(input.textParagraphs.map(paragraph => paragraph.replace(/\r?\n\s*$/, ''))) : input.html;
    const params = egoMediaParams(input);
    const rendered = await page.evaluate(renderEgoHtml, { html: originalHtml, markers: params.markers });
    if (rendered.positioned.length !== params.markers.length || rendered.positioned.some((marker, i) => marker !== params.markers[i])) {
      fail('IMAGE_POSITION_UNSUPPORTED', '正文配图应放在文章段落中，列表、标题、引用或链接内部的图片位置暂不可安全替换');
    }
    const hasLinks = rendered.links.length > 0;
    const stageHtml = (count, linked = false) => rendered.parts.filter(part => part.slot === null || part.slot < count)
      .map(part => linked ? part.linkedHtml : part.html).join('');
    const textHtml = stageHtml(0);
    const text = input.images.length ? rendered.parts.filter(part => part.slot === null).map(part => part.text).join('') : input.content;
    this.manifest = { ...await editorSnapshot(page, stageHtml(input.images.length, hasLinks)), coverKey: null,
      egoExternalLinkCount: rendered.links.length };
    this.draftId = null;
    this.saveExpected = null;
    this.saveStage = null;
    this.observeDraftSave = await observeEgoDraftResponse(page);
    const expectation = (snapshot, sources = []) => ({
      title: input.title,
      snapshot,
      images: sources.map(({ uri, caption }, index) => ({ uri: uri.replace(/^\/+/, ''), caption, marker: params.markers[index] })),
    });
    let snapshot = input.images.length || hasLinks ? await editorSnapshot(page, textHtml) : this.manifest;
    this.pendingSave = null;
    await this.measure('text', async () => {
      await page.click(TITLE, { label: '填写草稿文章标题' });
      await page.keyboard.paste(input.title);
      await page.waitForFunction(({ title, value }) => document.querySelector(title)?.value === value, { title: TITLE, value: input.title }, { timeout: 5000 });
      if (textHtml.trim()) {
        await page.click(BODY, { label: '定位草稿正文编辑区' });
        await page.keyboard.paste({ text, html: textHtml });
      }
      if ((input.images.length || hasLinks) && textHtml.trim()) await this.confirmSave('text', expectation(snapshot), true);
    });
    if (hasLinks) {
      this.saveStage = 'links';
      await checkChallenge(page);
      await this.measure('links', () => insertEgoExternalLinks(page, rendered.links));
      snapshot = await editorSnapshot(page, stageHtml(0, true));
      const updated = await readEditor(page);
      if (!updated || !matchesSnapshot(await editorSnapshot(page, updated.html), snapshot)) {
        fail('EXTERNAL_LINK_CONTENT_MISMATCH', '外链地址、位置或正文与 Markdown 不一致');
      }
      if (input.images.length) await this.confirmSave('links', expectation(snapshot), true);
    }
    if (!input.images.length) {
      this.pendingSave = { stage: hasLinks ? 'links' : 'text', expected: expectation(snapshot) };
      return this.manifest;
    }

    // An image-only draft starts with the editor's own empty caret paragraph.
    if (textHtml.trim()) {
      const pasted = await readEditor(page);
      if (!pasted || !matchesSnapshot(await editorSnapshot(page, pasted.html), snapshot)) {
        fail('EDITOR_CONTENT_MISMATCH', '富文本粘贴后，正文格式与 Markdown 不一致');
      }
    }
    let sources = [];
    for (const [index, image] of input.images.entries()) {
      await checkChallenge(page);
      snapshot = await editorSnapshot(page, stageHtml(index + 1, hasLinks));
      await this.measure(`image_${index + 1}`, async () => {
        await insertEgoImage(page, image, index, rendered.positions[index]);
        const state = await page.evaluate(readEgoMedia, params);
        if (!state || state.sources.length !== index + 1 || !state.sources[index].uri
          || sources.some((source, i) => source.uri !== state.sources[i].uri || source.caption !== state.sources[i].caption)
          || !matchesSnapshot(await editorSnapshot(page, state.html), snapshot)) {
          fail('IMAGE_ORDER_CHANGED', `第 ${index + 1} 张图：插图位置或正文结构与原稿不一致`);
        }
        await this.confirmSave(`image_${index + 1}`, expectation(snapshot, state.sources), true);
        await checkChallenge(page);
        await setEgoImageCaption(page, image, index);
        sources = state.sources.map((source, i) => i === index ? { ...source, caption: image.caption } : source);
        await this.confirmSave(`caption_${index + 1}`, expectation(snapshot, sources), true);
      });
    }
    const beforeCover = await page.evaluate(readEgoMedia, params);
    const mode = await this.measure('cover', () => setEgoCover(page, input.egoCover, sources));
    await checkChallenge(page);
    const media = await page.evaluate(readEgoMedia, params);
    const proof = egoMediaProof(media, input, mode);
    if (!proof || sources.some((source, i) => source.uri !== media.sources[i].uri)) {
      fail('EGO_MEDIA_UNVERIFIED', '正文图片描述或封面未按预期填写和加载');
    }
    this.manifest.egoMedia = await this.measure('media_proof', () => addEgoVisualProof(page, media, proof));
    if (mode !== beforeCover?.mode || media.covers.length !== beforeCover.covers.length
      || media.covers.some((cover, index) => cover.src !== beforeCover.covers[index].src)) {
      const covers = media.covers.map(cover => new URL(cover.src).pathname.replace(/^\/+/, ''));
      this.pendingSave = { stage: 'cover', expected: { ...expectation(snapshot, sources), covers } };
    }
    return this.manifest;
  }

  async checkReady(input) {
    await checkChallenge(this.page);
    if (!await matchesEditor(this.page, input, this.manifest)) {
      fail('EDITOR_CONTENT_MISMATCH', 'Ego 编辑器未完整接收标题、正文、图片描述或封面');
    }
  }

  async submit() {
    try {
      if (this.pendingSave) await this.confirmSave(this.pendingSave.stage, this.pendingSave.expected);
    } finally { this.editing = false; }
  }

  diagnose(stage) { return { stage, save_stage: this.saveStage, lookup: this.lastLookup }; }
}
