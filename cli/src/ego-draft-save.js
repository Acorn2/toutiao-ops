import { setTimeout as pause } from 'node:timers/promises';
import { contentSnapshot, digest, inspectContent, matchesSnapshot, recordId } from './article-records.js';
import { fail } from './errors.js';

const SAVE_URL = 'https://mp.toutiao.com/mp/agw/article/publish';
const SAVE_WAIT_MS = 45_000;
const IN_FLIGHT_AFTER_REJECTION_MS = 3_000;
const ID_FIELDS = ['pgc_id', 'draft_id', 'article_id', 'group_id', 'item_id', 'gid', 'id'];
const COVER_FIELDS = ['pgc_feed_covers', 'cover_images', 'covers', 'cover_image', 'cover'];

function parseJson(raw) {
  // Chromium returns JSON text. Preserve numeric IDs beyond JS integer precision.
  try {
    return JSON.parse(raw.replace(/"(?:[^"\\]|\\.)*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g, token =>
      /^\d{16,}$/.test(token) ? '"' + token + '"' : token));
  } catch { return null; }
}

function draftId(fields) {
  for (const key of ID_FIELDS) {
    const value = fields?.[key];
    if (/^[1-9]\d*$/.test(String(value))) return String(value);
  }
  return null;
}

function mediaPath(value) {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' ? url.pathname.replace(/^\/+/, '') : null;
  } catch {
    return /^\/?[\w.-]+\/[\w./%~-]+$/.test(value) ? value.replace(/^\/+/, '') : null;
  }
}

function coverList(data) {
  const extra = typeof data.extra === 'string' ? parseJson(data.extra) : data.extra;
  for (const source of [data, extra]) {
    for (const key of COVER_FIELDS) {
      const raw = source?.[key];
      if (raw == null || raw === '') continue;
      const value = typeof raw === 'string' ? parseJson(raw) ?? raw : raw;
      const covers = value?.images ?? value?.covers ?? value?.image_list ?? value;
      const list = Array.isArray(covers) ? covers : [covers];
      const paths = list.map(cover => mediaPath(typeof cover === 'object'
        ? cover?.url || cover?.image_url || cover?.src || cover?.uri || cover?.web_uri : cover));
      if (paths.every(Boolean)) return paths;
    }
  }
  return null;
}

function inspectSaveBody({ html, images }) {
  // template keeps outgoing HTML inert. Restore the same detached image-position
  // proof used on the source and the reopened editor.
  const root = document.createElement('template');
  root.innerHTML = html;
  let index = 0;
  for (const block of [...root.content.children]) {
    const all = block.matches('img') ? [block] : [...block.querySelectorAll('img')];
    if (!all.length) continue;
    const native = all.filter(node => node.hasAttribute('web_uri'));
    const image = native[0] || all[0];
    const expected = images[index++];
    if (!expected || (native.length || all.length) !== 1) return null;
    const uri = image.getAttribute('web_uri')?.replace(/^\/+/, '');
    let path;
    try {
      const url = new URL(image.getAttribute('src'));
      if (url.protocol === 'https:') path = url.pathname.replace(/^\/+/, '');
    } catch { /* Some outgoing figures only carry their object ID. */ }
    if (uri ? uri !== expected.uri : !path || (path !== expected.uri && !path.startsWith(expected.uri + '~'))) return null;
    const description = block.querySelector('figcaption, .pgc-img-caption, textarea.pgc-img-caption-ipt');
    const caption = (description?.textContent ?? block.textContent).normalize('NFC').trim();
    if (caption !== expected.caption.normalize('NFC')) return null;
    const placeholder = document.createElement('p');
    placeholder.textContent = expected.marker;
    block.replaceWith(placeholder);
  }
  return index === images.length ? root.innerHTML : null;
}

async function matchesBody(page, html, expected) {
  if (typeof html !== 'string') return false;
  const proof = expected.images.length
    ? await page.evaluate(inspectSaveBody, { html, images: expected.images }) : html;
  return proof !== null && matchesSnapshot(contentSnapshot(await page.evaluate(inspectContent, proof)), expected.snapshot);
}

export async function observeEgoDraftResponse(page) {
  await page.cdp('Network.enable', { maxPostDataSize: 131072 });
  await page.events();
  const requests = new Map();
  let sequence = 0;
  const isSave = value => value?.split('?')[0] === SAVE_URL;
  const read = async (method, requestId) => {
    const receipt = await page.cdp(method, { requestId }, { timeout: 2000 }).catch(() => null);
    return receipt?.result ?? receipt;
  };
  return async (expected, onRejected7050) => {
    for (const { method, params } of await page.events()) {
      if (method === 'Network.requestWillBeSent' && params.request?.method === 'POST' && isSave(params.request.url)) {
        const request = params.request;
        const raw = request.postData ?? (request.hasPostData ? (await read('Network.getRequestPostData', params.requestId))?.postData : null);
        if (typeof raw !== 'string') continue;
        const body = parseJson(raw) || Object.fromEntries(new URLSearchParams(raw));
        const id = draftId(body) || draftId(Object.fromEntries(new URL(request.url).searchParams));
        requests.set(params.requestId, { body, id, sequence: ++sequence });
      }
      const saved = requests.get(params.requestId);
      if (!saved) continue;
      if (method === 'Network.responseReceived' && isSave(params.response?.url)) saved.status = params.response.status;
      if (method === 'Network.loadingFailed') requests.delete(params.requestId);
    }

    const currentId = recordId(await page.url());
    if (expected.draftId && currentId && expected.draftId !== currentId) fail('DRAFT_ID_MISMATCH', '编辑器草稿 ID 已变化，停止写入');
    const targetId = expected.draftId || currentId;
    const sameDraft = ({ body, id }) => String(body.save) === '0' && String(body.is_app_preview) !== '1' && body.title === expected.title
      && (!targetId || id === targetId || (!expected.draftId && !id));
    let accepted = null;
    for (const [requestId, request] of requests) {
      const { body, id, status, sequence } = request;
      if (!sameDraft(request)) {
        requests.delete(requestId);
        continue;
      }
      if (request.matchedVersion !== expected) {
        if ((expected.covers && JSON.stringify(coverList(body)) !== JSON.stringify(expected.covers))
          || !await matchesBody(page, body.content, expected)) {
          requests.delete(requestId);
          continue;
        }
        request.matchedVersion = expected;
      }
      if (status === undefined) continue;
      if (status >= 400) fail('DRAFT_SAVE_REJECTED', `头条拒绝保存当前版本（HTTP ${status}）`);
      const result = await read('Network.getResponseBody', requestId);
      if (!result?.body) continue;
      requests.delete(requestId);
      const payload = parseJson(result.base64Encoded ? Buffer.from(result.body, 'base64').toString('utf8') : result.body);
      const code = payload?.code ?? payload?.errno ?? payload?.status_code;
      if (!/^-?\d{1,9}$/.test(String(code))) continue;
      if (Number(code) === 7050) {
        const message = payload.message ?? payload.data?.message;
        onRejected7050(sequence, {
          request: {
            method: 'POST',
            endpoint: SAVE_URL,
            save: typeof body.save === 'number' ? 0 : '0',
            is_app_preview: [0, '0', false].includes(body.is_app_preview) ? body.is_app_preview : null,
            preview_flag_present: Object.hasOwn(body, 'is_app_preview'),
            draft_id_present: !!id,
            content_sha256: digest(body.content),
            body_images: expected.images.length,
            filled_captions: expected.images.filter(image => image.caption.trim()).length,
          },
          response: {
            http_status: status,
            code: Number(code),
            ...(message === '保存失败' && { message }),
            ...(payload.reason === '保存失败' && { reason: payload.reason }),
          },
        });
        continue;
      }
      if (Number(code) !== 0) fail('DRAFT_SAVE_REJECTED', `头条拒绝保存当前版本（平台错误码 ${code}）`);
      const confirmedId = draftId(payload.data) || draftId(payload.data?.article) || draftId(payload) || id || currentId;
      const knownId = targetId || accepted?.draftId;
      if (knownId && confirmedId && knownId !== confirmedId) fail('DRAFT_ID_MISMATCH', '平台保存响应的草稿 ID 不一致，停止写入');
      accepted = { draftId: confirmedId || knownId, sequence };
    }
    return { accepted, pendingSequences: Array.from(requests.values(), request => request.sequence) };
  };
}

export async function waitEgoDraftSave(observe, expected, onRejectedSave) {
  const deadline = performance.now() + SAVE_WAIT_MS;
  let rejectedSequence = 0;
  let drainDeadline = null;
  let inFlightAtRejection;
  let confirmed = null;
  const onRejected7050 = (sequence, exchange) => {
    if (sequence > rejectedSequence) {
      rejectedSequence = sequence;
      drainDeadline ??= Math.min(deadline, performance.now() + IN_FLIGHT_AFTER_REJECTION_MS);
      onRejectedSave?.(exchange);
    }
  };
  do {
    const { accepted, pendingSequences } = await observe(expected, onRejected7050);
    if (confirmed?.draftId && accepted?.draftId && confirmed.draftId !== accepted.draftId) {
      fail('DRAFT_ID_MISMATCH', '平台对同一版本返回了不同草稿 ID，停止写入');
    }
    if (accepted && (!inFlightAtRejection || inFlightAtRejection.has(accepted.sequence))
      && (!confirmed || accepted.sequence > confirmed.sequence)) {
      confirmed = { ...accepted, draftId: accepted.draftId ?? confirmed?.draftId ?? null };
    }
    // A late response to an earlier request cannot supersede the rejection.
    const awaitingConfirmation = rejectedSequence && expected.draftId
      ? pendingSequences.some(sequence => sequence > (confirmed?.sequence ?? 0))
      : pendingSequences.length > 0;
    if (confirmed?.sequence > rejectedSequence && !awaitingConfirmation) return { draftId: confirmed.draftId };
    if (rejectedSequence) {
      inFlightAtRejection ??= new Set(pendingSequences);
      if (!pendingSequences.some(sequence => inFlightAtRejection.has(sequence) && sequence > rejectedSequence)
        || performance.now() >= drainDeadline) break;
    }
    await pause(250);
  } while (performance.now() < deadline);
  if (rejectedSequence) fail('DRAFT_SAVE_7050_UNCONFIRMED', '头条返回 7050，当前版本尚未确认保存');
  fail('SUBMISSION_UNCONFIRMED', '未收到与当前草稿版本匹配的保存响应，停止写入并回查');
}
