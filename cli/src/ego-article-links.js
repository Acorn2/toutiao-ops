import { fail } from './errors.js';

const BODY = '.ProseMirror[contenteditable="true"]';
const TOOL = '.syl-toolbar-tool.link.static button';
const DIALOG = '[role="dialog"]:has(.byte-tabs-header-title)';
const TAB = `${DIALOG} .byte-tabs-header-title:text-is("外部链接")`;
const FIELD = `${DIALOG} .byte-tabs-content-item-active input[placeholder="填写链接地址"]`;
const CONFIRM = `${DIALOG} button.byte-btn-primary`;

function selectUrl({ body, url, replace }) {
  const editor = document.querySelector(body);
  if (!editor) return false;
  const address = new URL(url).href;
  const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.parentElement.closest('a, pre, code, syl-inline, [contenteditable="false"], .syl-placeholder')) continue;
    const start = node.data.indexOf(url);
    if (start === -1) continue;
    const end = start + url.length;
    if (replace && (end !== node.length ||
      node.nextSibling?.querySelector?.(':scope > mask > a.pgc-link[href]')?.href !== address)) return false;
    editor.focus();
    const range = document.createRange();
    range.setStart(node, replace ? start : end);
    range.setEnd(node, end);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    return selection.anchorNode === node && selection.focusNode === node
      && selection.toString() === (replace ? url : '');
  }
  return false;
}

export async function insertEgoExternalLinks(page, links) {
  // With shared prefixes, remove the longer raw address first.
  const ordered = [...links].sort((a, b) => b.length - a.length);
  for (const url of ordered) {
    const args = { body: BODY, url };
    if (!await page.evaluate(selectUrl, args)) fail('EXTERNAL_LINK_POSITION_LOST', '无法定位正文中的外链原始地址');
    let action = '打开链接工具';
    try {
      await page.click(TOOL, { label: '打开正文链接工具' });
      action = '切换外部链接';
      await page.click(TAB, { label: '选择外部链接' });
      await page.waitForSelector(FIELD, { state: 'visible', timeout: 8000 });
      action = '填写链接地址';
      await page.fill(FIELD, url);
      const ready = await page.evaluate(({ dialog, field, url }) => {
        const input = document.querySelector(field);
        return input?.value === url && input.closest(dialog)?.querySelector('.byte-tabs-header-title.active')?.textContent.trim() === '外部链接';
      }, { dialog: DIALOG, field: FIELD, url });
      if (!ready) fail('EXTERNAL_LINK_ADDRESS_MISMATCH', '外部链接弹窗未接收正确地址');
      action = '确认插入链接';
      const confirm = await page.evaluate(selector => {
        const buttons = [...document.querySelectorAll(selector)];
        return buttons.length === 1 && buttons[0].getBoundingClientRect().height > 0
          && !buttons[0].disabled && buttons[0].textContent.trim() === '确定';
      }, CONFIRM);
      if (!confirm) fail('EXTERNAL_LINK_CONFIRM_UNAVAILABLE', '未确认外部链接弹窗的确定按钮');
      await page.click(CONFIRM, { label: '确认插入外部链接' });
      action = '等待头条返回链接';
      await page.waitForSelector(FIELD, { state: 'hidden', timeout: 26000 });
    } catch (error) {
      if (['EXTERNAL_LINK_ADDRESS_MISMATCH', 'EXTERNAL_LINK_CONFIRM_UNAVAILABLE'].includes(error.code)) throw error;
      fail('EXTERNAL_LINK_INSERT_FAILED', `外部链接处理失败（${action}）`);
    }
    if (!await page.evaluate(selectUrl, { ...args, replace: true })) {
      fail('EXTERNAL_LINK_POSITION_LOST', '无法核对原网址和插入链接的位置，已保留原网址');
    }
    await page.keyboard.press('Backspace');
  }
}
