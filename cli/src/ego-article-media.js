import { setTimeout as pause } from 'node:timers/promises';
import { digest, mediaKey } from './article-records.js';
import { validateImage } from './article-input.js';
import { fail } from './errors.js';

const EDITOR = '.ProseMirror';
const BODY = `${EDITOR}[contenteditable="true"]`;
const TITLE = 'textarea[placeholder*="标题"], input[placeholder*="标题"]';
const CARD = '.pgc-img img[web_uri]';
const CAPTION = `${EDITOR} textarea.pgc-img-caption-ipt`;
const DRAWER = '.mp-ic-img-drawer';
const IMAGE_UPLOAD = `${DRAWER} .upload-btn input[type="file"][accept*="image"]`;
const BODY_PICKER = `${DRAWER} .pgc-text-img .resource-item-txt .img-span`;
const COVER_SLOTS = '.article-cover-images .article-cover-img-wrap';
const COVER_OPEN = `${COVER_SLOTS}, .article-cover-images .article-cover-add`;
const COVER_RADIOS = '.article-cover .article-cover-radio-group label.byte-radio';

export function renderEgoHtml({ html, markers }) {
  const root = document.createElement('div');
  root.innerHTML = html;
  // The desktop editor exposes one native subheading style.
  for (const heading of root.querySelectorAll('h2,h3,h4,h5,h6')) {
    const subheading = document.createElement('h1');
    subheading.append(...heading.childNodes);
    heading.replaceWith(subheading);
  }
  const markerSet = new Set(markers);
  const positioned = [];
  for (const paragraph of [...root.children].filter(n => n.tagName === 'P')) {
    if (![...paragraph.children].some(n => n.tagName === 'SPAN' && markerSet.has(n.textContent))) continue;
    let run = document.createElement('p');
    const appendRun = () => {
      while (run.firstChild?.nodeName === 'BR') run.firstChild.remove();
      while (run.lastChild?.nodeName === 'BR') run.lastChild.remove();
      if (run.textContent.trim() || run.querySelector('a,code,strong,em,del')) paragraph.before(run);
      run = document.createElement('p');
    };
    for (const node of [...paragraph.childNodes]) {
      if (node.nodeName === 'SPAN' && markerSet.has(node.textContent)) {
        appendRun();
        const slot = document.createElement('p');
        positioned.push(node.textContent);
        slot.append(node);
        paragraph.before(slot);
      } else run.append(node);
    }
    appendRun();
    paragraph.remove();
  }
  const positions = [];
  const slots = new Map();
  let blockIndex = 0;
  for (const node of root.children) {
    const marker = node.tagName === 'P' && node.firstElementChild?.tagName === 'SPAN' && markerSet.has(node.textContent)
      ? node.textContent : null;
    if (marker) {
      positions.push(blockIndex);
      slots.set(node, slots.size);
    }
    if (node.tagName !== 'P' || node.textContent.trim() || node.querySelector('a,code,img')) blockIndex++;
  }
  // Keep the same detached proof for older operation records. Only the clean
  // HTML ever reaches the editor or its autosave.
  const links = [];
  const parts = [...root.childNodes].map(node => {
    const fragment = document.createElement('div');
    fragment.append(node.cloneNode(true));
    const external = [];
    for (const link of fragment.querySelectorAll('a[href]')) {
      const href = link.getAttribute('href');
      if (!/^https?:\/\//i.test(href) || link.textContent !== href) continue;
      const host = new URL(href).hostname;
      if (host === 'toutiao.com' || host.endsWith('.toutiao.com')) link.replaceWith(href);
      else {
        links.push(href);
        link.className = 'pgc-link';
        external.push(link);
      }
    }
    const linkedHtml = fragment.innerHTML;
    // The editor strips bare anchors on paste. Insert them with its link tool
    // after the initial text has been saved.
    for (const link of external) link.replaceWith(link.textContent);
    return { html: fragment.innerHTML, linkedHtml, text: fragment.textContent, slot: slots.get(node) ?? null };
  });
  return { positioned, positions, parts, links };
}

function selectImagePosition({ body, position }) {
  const editor = document.querySelector(body);
  if (!editor) return false;
  const blocks = [...editor.children].filter(node => node.tagName !== 'P' ||
    node.querySelector('a,code,img') || [...node.childNodes].some(child =>
      !child.matches?.('.syl-placeholder.ProseMirror-widget') && child.textContent.trim()));
  if (position < 0 || position > blocks.length) return false;
  editor.focus();
  const range = document.createRange();
  const next = blocks[position];
  const previous = blocks[position - 1];
  let paragraphEnd;
  if (previous?.tagName === 'P' && /^H[1-6]$/.test(next?.tagName ?? '')) {
    // A root-level DOM range before a heading can be normalized into the
    // heading. Place a real text caret inside the preceding paragraph.
    const textNodes = document.createTreeWalker(previous, NodeFilter.SHOW_TEXT);
    for (let node = textNodes.nextNode(); node; node = textNodes.nextNode()) {
      if (node.data.trim()) paragraphEnd = node;
    }
    if (!paragraphEnd) return false;
  }
  // Use the edge of an editable paragraph where possible. For an empty body
  // or after an image, use a real empty caret paragraph if the editor has one.
  if (paragraphEnd) range.setStart(paragraphEnd, paragraphEnd.length);
  else if (next?.tagName === 'P') range.setStart(next, 0);
  else if (!next && previous?.tagName === 'P') range.setStart(previous, previous.childNodes.length);
  else if (!next && editor.lastElementChild?.tagName === 'P') range.setStart(editor.lastElementChild, 0);
  else if (next) range.setStartBefore(next);
  else range.setStart(editor, editor.childNodes.length);
  range.collapse(true);
  const selection = window.getSelection();
  if (!selection) return false;
  selection.removeAllRanges();
  selection.addRange(range);
  return selection.isCollapsed && !!selection.anchorNode && editor.contains(selection.anchorNode)
    && (!paragraphEnd || (selection.anchorNode === paragraphEnd && selection.anchorOffset === paragraphEnd.length));
}

function imageUploadState({ body, card, drawer, count, upload, phase }) {
  if (/\/auth\/|login/.test(location.pathname)) return 'login';
  const challenge = [...document.querySelectorAll('iframe[src*="captcha"], [class*="captcha"], [role="dialog"]')]
    .some(node => node.getBoundingClientRect().height > 0 && (node.matches('iframe[src*="captcha"], [class*="captcha"]')
      || /安全验证|完成验证/.test(node.innerText)));
  if (challenge) return 'challenge';
  const editor = document.querySelector(body);
  if (!editor) return 'missing_editor';
  const panel = [...document.querySelectorAll(drawer)].find(n => n.getBoundingClientRect().height > 0);
  const text = panel?.innerText || '';
  if (/上传失败|上传错误/.test(text)) return 'failed';
  if (phase === 'file') return document.querySelector(upload) ? 'file_ready' : false;
  const cards = editor.querySelectorAll(card);
  if (cards.length > count) return 'extra';
  if (cards.length === count) {
    const image = cards[count - 1];
    const display = image.closest('[contenteditable="false"]')?.querySelector('.img-loading-container img');
    if (display?.complete && display.naturalWidth === 0 && /^https:\/\//.test(display.src)) return 'failed';
    if (/^https:\/\//.test(image.src) && image.getAttribute('web_uri') && display?.complete && display.naturalWidth) return 'inserted';
    return false;
  }
  if (phase !== 'upload' || !panel || /上传中|正在上传/.test(text)) return false;
  const confirm = [...panel.querySelectorAll('button')].find(n => /^(确定|插入)$/.test(n.textContent.trim()) && !n.disabled && n.getBoundingClientRect().height > 0);
  const loaded = [...panel.querySelectorAll('.byte-tabs-content-item-active img')].some(img => /^https:\/\//.test(img.src) && img.complete && img.naturalWidth);
  const reported = text.match(/已上传\s*(\d+)\s*张图片/);
  if (reported && Number(reported[1]) > 1) return 'extra';
  return confirm && (loaded || reported?.[1] === '1' || /上传成功|上传完成/.test(text)) ? 'confirm' : false;
}

async function clickButton(page, selector, pattern, label) {
  const indexes = await page.evaluate(({ selector, pattern }) => [...document.querySelectorAll(selector)].flatMap((node, i) =>
    new RegExp(pattern).test(node.textContent.trim()) && !node.disabled && node.getBoundingClientRect().height > 0 ? [i] : []),
  { selector, pattern });
  if (indexes.length !== 1) fail('EGO_MEDIA_CONTROL_UNAVAILABLE', `未唯一找到${label}控件`);
  await page.click(`${selector} >> nth=${indexes[0]}`, { label });
}

export async function insertEgoImage(page, image, index, position) {
  if (validateImage(image.path).sha256 !== image.sha256) fail('INPUT_CHANGED', '图片在校验后发生变化，停止上传');
  if (!await page.evaluate(selectImagePosition, { body: BODY, position })) {
    fail('IMAGE_POSITION_LOST', `第 ${index + 1} 张图：未找到正文插图位置`);
  }
  await page.click('.syl-toolbar-tool.image.static button', { label: '打开正文图片上传' });
  const params = { body: EDITOR, card: CARD, drawer: DRAWER, upload: IMAGE_UPLOAD, count: index + 1 };
  let phase = 'file';
  // Keep waiting for the current upload. Time passing does not warrant sending
  // the file again or moving to the next image.
  for (;;) {
    const state = await page.evaluate(imageUploadState, { ...params, phase });
    switch (state) {
      case 'inserted': return;
      case 'file_ready':
        await page.setInputFiles(IMAGE_UPLOAD, [image.path]);
        phase = 'upload';
        break;
      case 'confirm':
        await clickButton(page, `${DRAWER} button`, '^(确定|插入)$', '确认插入正文图片');
        phase = 'insert';
        break;
      case 'login': fail('AUTH_REQUIRED', '请在该 Ego Profile 登录指定的头条号');
      case 'challenge': fail('MANUAL_VERIFICATION_REQUIRED', '头条要求人工完成安全验证');
      case 'missing_editor': fail('IMAGE_POSITION_LOST', `第 ${index + 1} 张图：上传中未找到正文编辑器`);
      case 'failed':
      case 'extra': fail('IMAGE_UPLOAD_FAILED', `第 ${index + 1} 张图：上传失败或插入数量异常`);
      default: await pause(250);
    }
  }
}

export async function setEgoImageCaption(page, image, index) {
  const target = `${CAPTION} >> nth=${index}`;
  const field = { selector: CAPTION, index };
  const focused = ({ selector, index }) => {
    const caption = document.querySelectorAll(selector)[index];
    return !!caption && !caption.disabled && !caption.readOnly && caption === document.activeElement;
  };
  let stage = 'locate';
  try {
    await page.waitForSelector(target, { state: 'visible', timeout: 8000 });
    stage = 'focus';
    if (!await page.evaluate(focused, field)) await page.focus(target);
    await page.waitForFunction(focused, field, { timeout: 5000 });
    stage = 'paste';
    await page.keyboard.paste(image.caption);
    stage = 'readback';
    await page.waitForFunction(({ selector, index, value }) => document.querySelectorAll(selector)[index]?.value === value,
      { ...field, value: image.caption }, { timeout: 5000 });
  } catch {
    const actions = { locate: '定位描述框', focus: '聚焦描述框', paste: '粘贴描述', readback: '核对描述内容' };
    fail(`IMAGE_CAPTION_${stage.toUpperCase()}_FAILED`, `第 ${index + 1} 张图：${actions[stage]}失败`);
  }
  // Leaving the caption commits it and restores the body insertion caret.
  await page.click(TITLE, { label: '完成图片描述编辑' });
  await page.waitForSelector(BODY, { state: 'visible', timeout: 5000 });
}

export function readEgoMedia({ body, card, slots, radios, markers }) {
  const editor = document.querySelector(body);
  if (!editor) return null;
  const copy = editor.cloneNode(true);
  const sources = [];
  const copiedNodes = [...copy.children];
  for (const [i, node] of [...editor.children].entries()) {
    const native = node.querySelectorAll(card);
    const preview = node.querySelector('.img-loading-container img');
    const caption = node.querySelector('textarea.pgc-img-caption-ipt');
    if (!native.length) continue;
    if (native.length !== 1 || !preview || !caption || sources.length >= markers.length) return null;
    sources.push({ src: native[0].src, uri: native[0].getAttribute('web_uri'),
      ready: preview.complete && preview.naturalWidth > 0, caption: caption.value });
    const placeholder = document.createElement('p');
    placeholder.textContent = markers[sources.length - 1];
    copiedNodes[i].replaceWith(placeholder);
  }
  copy.querySelectorAll('.syl-placeholder.ProseMirror-widget').forEach(node => node.remove());
  const covers = [...document.querySelectorAll(slots)].filter(slot => slot.getBoundingClientRect().height > 0).map(slot => {
    const img = slot.querySelector('img');
    return { src: img?.src, ready: !!img?.complete && img.naturalWidth > 0 };
  });
  const mode = [...document.querySelectorAll(radios)].find(n => n.querySelector('input[type="radio"]')?.checked
    || n.querySelector('.byte-radio-inner.checked'))?.textContent.trim();
  return { html: copy.innerHTML, sources, covers, mode };
}

export function egoMediaParams(input) {
  return { body: EDITOR, card: CARD, slots: COVER_SLOTS, radios: COVER_RADIOS, markers: input.images.map(x => x.marker) };
}

function coverRadio({ selector, label }) {
  const indicators = [...document.querySelectorAll(`${selector} .byte-radio-inner`)];
  return [...document.querySelectorAll(selector)].flatMap((node, index) => {
    const radio = node.querySelector('input[type="radio"]');
    const indicator = node.querySelector('.byte-radio-inner');
    return radio && node.getBoundingClientRect().height > 0 && node.textContent.trim() === label
      ? [{ index, indicatorIndex: indicators.indexOf(indicator), checked: radio.checked || !!indicator?.classList.contains('checked') }] : [];
  });
}

function pickerItem({ selector, uri }) {
  return [...document.querySelectorAll(selector)].flatMap((node, i) => {
    const background = getComputedStyle(node).backgroundImage;
    const match = background.match(/^url\(["']?(https:\/\/[^"')]+)["']?\)$/);
    if (!match || !node.getBoundingClientRect().height) return [];
    const path = new URL(match[1]).pathname;
    return path === `/${uri}` || path.startsWith(`/${uri}~`) ? [i] : [];
  });
}

export async function setEgoCover(page, indexes, sources, onStep, current) {
  const label = indexes.length === 3 ? '三图' : indexes.length === 1 ? '单图' : '无封面';
  const state = await page.evaluate(coverRadio, { selector: COVER_RADIOS, label });
  if (state.length !== 1) fail('COVER_CONTROL_UNAVAILABLE', '未能唯一确认头条封面模式');
  const { checked, index, indicatorIndex } = state[0];
  if (checked && label === '单图' && current?.mode === label && current.covers.length === 1 && current.covers[0].ready) {
    const source = sources[indexes[0]];
    const selected = signedAsset(current.covers[0].src);
    const intended = source && signedAsset(source.src, source.uri);
    if (selected && intended && selected.variant === intended.variant && selected.object === intended.object) return label;
  }
  if (!checked) {
    const target = indicatorIndex < 0 ? `${COVER_RADIOS} >> nth=${index}` : `${COVER_RADIOS} .byte-radio-inner >> nth=${indicatorIndex}`;
    await page.click(target, { label: `选择${label}封面模式` });
  }
  // The old single-cover slot can remain visible while the three-cover
  // controls hydrate. Only open the picker after both have switched.
  onStep?.('wait_cover_slots');
  await page.waitForFunction(({ radios, slots, label, count }) => {
    const selected = [...document.querySelectorAll(radios)].some(node => node.textContent.trim() === label &&
      (node.querySelector('input[type="radio"]')?.checked || node.querySelector('.byte-radio-inner.checked')));
    const visible = [...document.querySelectorAll(slots)].filter(slot => slot.getBoundingClientRect().height > 0);
    return selected && visible.length === count;
  }, { radios: COVER_RADIOS, slots: COVER_OPEN, label, count: indexes.length }, { timeout: 12000 });
  // Switching to three covers may retain the first automatic cover. The
  // picker attached to the first empty slot then accepts the two remaining ones.
  const retainedFirst = indexes.length === 3 && indexes[0] === 0 && await page.evaluate(selector => {
    const slots = [...document.querySelectorAll(selector)].filter(slot => slot.getBoundingClientRect().height > 0);
    return slots.length === 3 && !!slots[0].querySelector('img') &&
      slots.slice(1).every(slot => slot.matches('.article-cover-add'));
  }, COVER_OPEN);
  for (let i = retainedFirst ? 1 : 0; i < indexes.length;) {
    onStep?.(`open_cover_slot_${i + 1}`);
    const slot = `${COVER_OPEN} >> nth=${i}`;
    await page.waitForSelector(slot, { state: 'visible', timeout: 8000 });
    const replace = await page.evaluate(({ open, replacement, index }) => [...document.querySelectorAll(replacement)]
      .findIndex(node => node.closest(open) === document.querySelectorAll(open)[index]),
    { open: COVER_OPEN, replacement: `${COVER_SLOTS} .article-cover-img-replace`, index: i });
    await page.click(replace >= 0 ? `${COVER_SLOTS} .article-cover-img-replace >> nth=${replace}` : slot, { label: '打开正文图片封面选择器' });
    onStep?.('wait_cover_picker');
    await page.waitForSelector(`${BODY_PICKER} >> nth=0`, { state: 'visible', timeout: 8000 });
    const choose = async index => {
      onStep?.(`choose_cover_image_${index + 1}`);
      const uri = sources[indexes[index]]?.uri?.replace(/^\//, '');
      if (!uri || !signedAsset(sources[indexes[index]].src, uri)) fail('COVER_IMAGE_UNVERIFIED', '对应正文图片缺少可确认的媒体标识');
      const matches = await page.evaluate(pickerItem, { selector: BODY_PICKER, uri });
      if (matches.length === 0) fail('COVER_IMAGE_UNAVAILABLE', '正文图片未出现在头条封面选择器中');
      await page.click(`${BODY_PICKER} >> nth=${matches[0]}`, { label: '选取正文图片作为封面' });
    };
    await choose(i);
    const limit = await page.evaluate(selector => Number([...document.querySelectorAll(selector)]
      .find(n => n.getBoundingClientRect().height > 0)?.innerText.match(/最多可选择\s*(\d+)\s*张/)?.[1] || 1), DRAWER);
    if (limit < 1 || limit > indexes.length - i) fail('COVER_CONTROL_UNAVAILABLE', '封面选择数量与预期不符');
    for (let n = 1; n < limit; n++) await choose(i + n);
    onStep?.('confirm_cover_picker');
    await clickButton(page, `${DRAWER} button`, '^确定$', '确认封面选择');
    await page.waitForSelector(DRAWER, { state: 'hidden', timeout: 15000 });
    i += limit;
  }
  const expected = { slots: COVER_SLOTS, count: indexes.length };
  onStep?.('wait_cover_images');
  await page.waitForFunction(({ slots, count }) => {
    const visible = [...document.querySelectorAll(slots)].filter(slot => slot.getBoundingClientRect().height > 0);
    return visible.length === count && visible.every(slot => {
      const img = slot.querySelector('img');
      return img?.complete && img.naturalWidth > 0 && /^https:\/\//.test(img.src);
    });
  }, expected, { timeout: 15000 });
  return label;
}

function signedAsset(src, uri) {
  try {
    const url = new URL(src);
    const match = url.pathname.match(/^\/(tos-[\w-]+\/[\w-]+)(?:~[^/]+)?$/);
    if (url.protocol !== 'https:' || url.username || url.password || url.port ||
        !/^(?:image-tt-private\.toutiao\.com|p\d+-sign\.toutiaoimg\.com)$/.test(url.hostname) ||
        !(url.searchParams.has('x-orig-sign') || url.searchParams.has('x-signature')) ||
        !match || (uri && match[1] !== uri.replace(/^\//, ''))) return null;
    // Signatures can rotate on reopening. Retain every content-affecting query
    // parameter alongside the exact URL digest in the stored proof.
    for (const key of ['traceid', 'x-orig-authkey', 'x-orig-expires', 'x-orig-sign', 'x-expires', 'x-signature']) {
      url.searchParams.delete(key);
    }
    url.searchParams.sort();
    return { object: match[1], variant: url.pathname + url.search };
  } catch { return null; }
}

function imageProof(image) {
  const asset = signedAsset(image.src, image.uri);
  return { key: mediaKey(image.src), asset: asset && digest(asset.object),
    variant: asset && digest(asset.variant), caption: image.caption === undefined ? null : digest(image.caption.normalize('NFC')) };
}

export function egoMediaProof(actual, input, mode) {
  if (!actual || actual.mode !== mode || actual.sources.length !== input.images.length || actual.covers.length !== input.egoCover.length ||
    ![...actual.sources, ...actual.covers].every(i => i.ready && mediaKey(i.src)) ||
    actual.sources.some((i, n) => i.caption !== input.images[n].caption)) return null;
  const images = actual.sources.map(imageProof);
  const covers = actual.covers.map(imageProof);
  const mediaId = item => item.asset || item.key;
  if (new Set(covers.map(mediaId)).size !== covers.length) return null;
  // A newly cropped cover can have its own object ID. A cover that points
  // directly at a known body image must point at the intended one.
  const sourceIds = images.map(mediaId);
  if (covers.some((cover, index) => {
    const id = mediaId(cover);
    return sourceIds.includes(id) && id !== sourceIds[input.egoCover[index]];
  })) return null;
  return { mode, images, covers };
}

async function sampleRenderedMedia(page, sources) {
  const response = await page.cdp('Page.getResourceTree', {}, { timeout: 2500 }).catch(() => null);
  const frameId = (response?.result || response)?.frameTree?.frame?.id;
  if (!frameId) return sources.map(() => null);
  const samples = [];
  for (const source of sources) {
    if (!signedAsset(source.src, source.uri)) { samples.push(null); continue; }
    const result = await page.cdp('Page.getResourceContent', { frameId, url: source.src }, { timeout: 2500 }).catch(() => null);
    const resource = result?.result || result;
    if (!resource?.base64Encoded || !resource.content || resource.content.length > 3_000_000) { samples.push(null); continue; }
    const sampled = await page.evaluate(async data => {
      try {
        const image = await createImageBitmap(new Blob([Uint8Array.from(atob(data), ch => ch.charCodeAt(0))]));
        const canvas = new OffscreenCanvas(20, 20);
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, 20, 20);
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(image, 0, 0, 20, 20);
        const rgba = ctx.getImageData(0, 0, 20, 20).data;
        const rgb = [];
        for (let i = 0; i < rgba.length; i += 4) rgb.push(rgba[i], rgba[i + 1], rgba[i + 2]);
        return { ratio: image.width / image.height, rgb: btoa(String.fromCharCode(...rgb)) };
      } catch { return null; }
    }, resource.content).catch(() => null);
    samples.push(sampled);
  }
  return samples;
}

export async function addEgoVisualProof(page, actual, proof) {
  // Read only the images Chromium has already loaded in this editor. Keep the
  // exact URL digest and add a small local sample for platform-generated crops.
  const samples = await sampleRenderedMedia(page, [...actual.sources, ...actual.covers]);
  const withSample = (records, offset) => records.map((record, i) => samples[offset + i]
    ? { ...record, visual: samples[offset + i] } : record);
  return { ...proof, images: withSample(proof.images, 0), covers: withSample(proof.covers, proof.images.length) };
}

function sameVisual(a, b) {
  if (!a?.rgb || !b?.rgb || !a.ratio || !b.ratio || Math.abs(a.ratio / b.ratio - 1) > 0.015) return false;
  const x = Buffer.from(a.rgb, 'base64'), y = Buffer.from(b.rgb, 'base64');
  if (x.length !== 1200 || y.length !== x.length) return false;
  let difference = 0;
  let changed = 0;
  for (let i = 0; i < x.length; i++) {
    const delta = Math.abs(x[i] - y[i]);
    difference += delta;
    if (delta > 14) changed++;
  }
  return difference <= x.length * 4 && changed <= x.length * 0.08;
}

export function matchesEgoMedia(proof, expected) {
  const matches = (a, b, cover = false) => a.length === b.length && a.every((actual, i) => {
    const saved = b[i];
    return actual.caption === saved.caption && !!actual.key && (actual.key === saved.key ||
      (actual.asset && actual.asset === saved.asset && actual.variant === saved.variant) ||
      (actual.asset && saved.asset && (cover || actual.asset === saved.asset) && sameVisual(actual.visual, saved.visual) &&
        (!cover || !b.some((other, n) => n !== i && sameVisual(actual.visual, other.visual)))));
  });
  return !!proof && proof.mode === expected.mode && matches(proof.images, expected.images) && matches(proof.covers, expected.covers, true);
}
