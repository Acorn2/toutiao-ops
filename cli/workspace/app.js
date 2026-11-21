import { computed, createApp, h, onMounted, onUnmounted, reactive, ref, watch } from '/vue.js';

const tabs = [
  { id: 'drafts', name: '头条草稿箱' },
  { id: 'published', name: '已发布文章' },
  { id: 'queue', name: '本地队列' },
];
const errors = {
  ACCOUNT_BUSY: '账号正在处理其他任务，请稍后重试。',
  ACCOUNT_MISMATCH: 'Ego 当前登录的头条号与账号绑定不一致。',
  AUTH_REQUIRED: '请在该账号绑定的 Ego Profile 重新登录。',
  IDENTITY_UNAVAILABLE: '暂时无法确认登录身份，请检查 Ego。',
  EGO_ACCOUNT_UNBOUND: '这个账号还没有绑定 Ego Profile。',
  EGO_NOT_INSTALLED: '请打开 Ego Lite 并检查本机 ego-browser。',
  MANUAL_VERIFICATION_REQUIRED: '请在 Ego 完成头条的安全验证后重试。',
  LIST_VIEW_UNVERIFIED: '头条草稿列表尚未完成加载，请重试。',
  DRAFT_LIST_CHANGED: '草稿列表已变化，请同步后再打开。',
  PUBLISHED_LIST_UNAVAILABLE: '暂时无法读取头条已发布文章。',
};
const stages = { pending: '待保存', running: '处理中', verified: '已核对', blocked: '保存受阻', unverified: '待核对' };
const clock = new Intl.DateTimeFormat('zh-CN', {
  month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
});
const PAGE_SIZE = 15;

const shapes = {
  copy: [
    ['rect', { x: 9, y: 9, width: 11, height: 11, rx: 2.5 }],
    ['path', { d: 'M5 15H4.5A2.5 2.5 0 0 1 2 12.5v-8A2.5 2.5 0 0 1 4.5 2h8A2.5 2.5 0 0 1 15 4.5V5' }],
  ],
  check: [['path', { d: 'M20 6 9 17l-5-5' }]],
  external: [
    ['path', { d: 'M15 3h6v6' }],
    ['path', { d: 'M10 14 21 3' }],
    ['path', { d: 'M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6' }],
  ],
  sync: [
    ['path', { d: 'M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8' }],
    ['path', { d: 'M21 3v5h-5' }],
    ['path', { d: 'M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16' }],
    ['path', { d: 'M8 16H3v5' }],
  ],
  search: [
    ['circle', { cx: 11, cy: 11, r: 6.5 }],
    ['path', { d: 'm16 16 4.5 4.5' }],
  ],
  draft: [
    ['path', { d: 'M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z' }],
    ['path', { d: 'M14 2v4a2 2 0 0 0 2 2h4' }],
    ['path', { d: 'M9 13h6' }],
    ['path', { d: 'M9 17h4' }],
  ],
  published: [
    ['path', { d: 'M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z' }],
    ['path', { d: 'M14 2v4a2 2 0 0 0 2 2h4' }],
    ['path', { d: 'm9 15 2 2 4-4' }],
  ],
  queue: [
    ['circle', { cx: 12, cy: 12, r: 8.5 }],
    ['path', { d: 'M12 7.5V12l3 2' }],
  ],
  inbox: [
    ['path', { d: 'M22 12h-6l-2 3h-4l-2-3H2' }],
    ['path', { d: 'M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z' }],
  ],
  alert: [
    ['circle', { cx: 12, cy: 12, r: 9 }],
    ['path', { d: 'M12 8v4' }],
    ['path', { d: 'M12 16.2v.1' }],
  ],
  clock: [
    ['circle', { cx: 12, cy: 12, r: 8.5 }],
    ['path', { d: 'M12 7.5V12l3 2' }],
  ],
  lock: [
    ['rect', { x: 3.5, y: 10.5, width: 17, height: 10, rx: 2.5 }],
    ['path', { d: 'M7.5 10.5V7a4.5 4.5 0 0 1 9 0v3.5' }],
  ],
  chevronLeft: [['path', { d: 'm14.5 6-6 6 6 6' }]],
  chevronRight: [['path', { d: 'm9.5 6 6 6-6 6' }]],
  user: [
    ['circle', { cx: 12, cy: 8, r: 4 }],
    ['path', { d: 'M4.5 20.5a7.5 7.5 0 0 1 15 0' }],
  ],
};

function icon(name, extraClass) {
  return h('svg', {
    class: ['icon', extraClass], viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
    'stroke-width': 1.7, 'stroke-linecap': 'round', 'stroke-linejoin': 'round',
    'aria-hidden': 'true', focusable: 'false',
  }, (shapes[name] || []).map(([tag, attrs]) => h(tag, attrs)));
}

function formatTime(value) {
  const date = new Date(value || NaN);
  return Number.isNaN(date.valueOf()) ? '—' : clock.format(date);
}

function button(content, attrs = {}) {
  return h('button', { type: 'button', ...attrs }, content);
}

function accountName(account) {
  return account.display_name || account.account;
}

function safeLink(value, pattern) {
  return pattern.test(value || '') ? value : null;
}

const profileLink = value => safeLink(value, /^https:\/\/www\.toutiao\.com\/c\/user\/\d+\/$/);
const articleLink = value => safeLink(value, /^https:\/\/www\.toutiao\.com\/(?:item|article)\/\d+\/$/);

async function request(path, payload) {
  const response = await fetch(path, payload === undefined ? undefined : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
  });
  const data = await response.json();
  if (!response.ok || data.success === false) {
    throw new Error(errors[data.error_code] || data.message || '请求未完成，请稍后重试。');
  }
  return data;
}

function AccountNav({ accounts, selected, select }) {
  return h('aside', { class: 'sidebar' }, [
    h('div', { class: 'brand' }, [
      h('img', { class: 'brand-mark', src: '/logo.svg', width: 36, height: 36, alt: '' }),
      h('span', { class: 'brand-copy' }, [
        h('strong', '发稿工作台'),
        h('small', 'Toutiao Ops'),
      ]),
    ]),
    h('div', { class: 'side-head' }, [h('span', '头条号'), h('span', { class: 'side-count' }, String(accounts.length))]),
    h('nav', { class: 'accounts', 'aria-label': '头条账号' }, accounts.map(account => h('button', {
      key: account.account, type: 'button', class: ['account-option', { active: account.account === selected }],
      'aria-current': account.account === selected ? 'true' : undefined, onClick: () => select(account.account),
    }, [
      h('span', { class: 'avatar', 'aria-hidden': 'true' }, account.display_name?.trim().at(0) || '号'),
      h('strong', { class: 'account-name' }, accountName(account)),
      h('span', { class: ['dot', { connected: account.ego_profile_bound }], title: account.ego_profile_bound ? 'Ego 已绑定' : 'Ego 未绑定' },
        h('span', { class: 'sr-only' }, account.ego_profile_bound ? 'Ego 已绑定' : 'Ego 未绑定')),
    ]))),
    h('div', { class: 'side-foot' }, [icon('lock'), h('span', '草稿与队列数据仅存本机私有目录')]),
  ]);
}

function copyButton(value, label, key, copied, copy) {
  const done = copied === key;
  return h('button', {
    type: 'button',
    class: ['icon-button', { copied: done }],
    title: done ? '已复制' : label,
    'aria-label': done ? '已复制' : label,
    onClick: () => copy(value, `已复制${label.replace(/^复制/, '')}`, key),
  }, done ? [icon('check'), h('span', { class: 'copy-label' }, '已复制')] : [icon('copy')]);
}

const CodexInstruction = {
  props: ['account', 'copy', 'copied'],
  setup(props) {
    const path = ref('');
    const done = computed(() => props.copied === 'codex');

    function copyInstruction() {
      const contentFile = path.value.trim();
      const prompt = [
        '请使用 toutiao-ops 将这篇 Markdown 文稿保存到头条草稿箱。',
        `账号别名：${props.account}`,
        `文稿路径：${contentFile || '/请替换为完整路径/头条版.md'}`,
        '',
        '请先校验 Markdown 和文中引用的配图，使用 Ego 保存草稿，重开核对正文、图片、外链和封面后，把草稿入口发给我。正式发布由我手动完成。',
      ].join('\n');
      void props.copy(prompt, contentFile ? '已复制 Codex 存稿指令' : '已复制模板，粘贴后替换文稿路径', 'codex');
    }

    return () => h('section', { class: 'card panel', 'aria-labelledby': 'codex-heading' }, [
      h('h3', { id: 'codex-heading' }, '存稿指令'),
      h('p', { class: 'panel-desc' }, '把文稿路径写进指令，交给 Codex 走存稿流程。'),
      h('label', { class: 'path-field' }, [
        h('span', { class: 'meta-label' }, '文稿路径（可选）'),
        h('input', {
          type: 'text', value: path.value, placeholder: '/完整路径/头条版.md', autocomplete: 'off', spellcheck: 'false',
          onInput: event => { path.value = event.target.value; },
        }),
      ]),
      button([icon(done.value ? 'check' : 'copy'), done.value ? '已复制指令' : '复制 Codex 指令'], {
        class: ['action', 'secondary', 'block', { copied: done.value }], onClick: copyInstruction,
      }),
    ]);
  },
};

function AccountHeading({ account, copy, copied, syncing, sync }) {
  const bound = account.ego_profile_bound;
  const profile = profileLink(account.profile_url);
  return h('header', { class: 'page-head' }, [
    h('div', { class: 'head-titles' }, [
      h('span', { class: ['status-pill', { off: !bound }] }, [
        h('span', { class: ['dot', { connected: bound }] }),
        bound ? 'Ego 已绑定' : 'Ego 未绑定',
      ]),
      h('h1', accountName(account)),
    ]),
    h('div', { class: 'head-actions' }, [
      button([icon(copied === 'account' ? 'check' : 'copy'), copied === 'account' ? '已复制账号信息' : '复制账号信息'], {
        class: 'action secondary',
        onClick: () => copy([
          `昵称：${accountName(account)}`, `账号别名：${account.account}`,
          account.user_id && `头条号数字 ID：${account.user_id}`, profile && `账号主页：${profile}`,
        ].filter(Boolean).join('\n'), '已复制账号信息', 'account'),
      }),
      button([icon('sync', syncing ? 'spinning' : ''), syncing ? '正在同步…' : '立即同步'], {
        class: 'action primary',
        disabled: syncing || !bound,
        title: bound ? undefined : '请先绑定 Ego Profile',
        onClick: () => sync(account.account),
      }),
    ]),
  ]);
}

function AccountRail({ account, copy, copied }) {
  const bound = account.ego_profile_bound;
  const profile = profileLink(account.profile_url);
  const metaItem = (label, value, key, action) => h('div', { class: 'meta-item' }, [
    h('div', { class: 'meta-text' }, [h('span', { class: 'meta-label' }, label), h('code', value || '—')]),
    value && copyButton(value, action, key, copied, copy),
  ]);
  return h('aside', { class: 'rail' }, [
    h('section', { class: 'card panel', 'aria-labelledby': 'identity-heading' }, [
      h('h3', { id: 'identity-heading' }, '账号信息'),
      metaItem('账号别名', account.account, 'alias', '复制账号别名'),
      metaItem('数字 ID', account.user_id, 'uid', '复制数字 ID'),
      h('div', { class: 'meta-item' }, [
        h('div', { class: 'meta-text' }, [h('span', { class: 'meta-label' }, '绑定状态')]),
        h('span', { class: 'meta-value' }, [
          h('span', { class: ['dot', { connected: bound }] }),
          bound ? 'Ego 已绑定' : 'Ego 未绑定',
        ]),
      ]),
      profile && h('a', { class: 'panel-link', href: profile, target: '_blank', rel: 'noreferrer' }, [
        '打开头条号主页', icon('external'),
      ]),
    ]),
    h(CodexInstruction, { account: account.account, copy, copied }),
    h('p', { class: 'rail-note' }, [icon('lock'), h('span', '同步只读取草稿与已发布列表，写入止于草稿箱。')]),
  ]);
}

createApp({
  setup() {
    const accounts = ref([]);
    const selected = ref('');
    const view = ref('drafts');
    const query = ref('');
    const page = ref(1);
    const loading = ref(true);
    const loadError = ref('');
    const notice = ref('');
    const noticeTone = ref('ok');
    const copied = ref('');
    const syncing = reactive(new Set());
    const syncErrors = reactive(new Map());
    const opening = ref('');
    let toastTimer;
    let copiedTimer;

    const account = computed(() => accounts.value.find(item => item.account === selected.value));
    const list = computed(() => {
      const data = account.value;
      if (!data) return [];
      if (view.value === 'drafts') return data.drafts?.rows || [];
      if (view.value === 'published') return data.publications?.articles || [];
      return data.tasks || [];
    });
    const filtered = computed(() => list.value.filter(row => row.title.toLocaleLowerCase('zh-CN')
      .includes(query.value.trim().toLocaleLowerCase('zh-CN'))));
    const pages = computed(() => Math.max(1, Math.ceil(filtered.value.length / PAGE_SIZE)));
    const visible = computed(() => filtered.value.slice((page.value - 1) * PAGE_SIZE, page.value * PAGE_SIZE));
    const activeSync = computed(() => view.value === 'drafts' ? account.value?.drafts
      : view.value === 'published' ? account.value?.publications : null);

    function inform(message, tone = 'ok') {
      notice.value = message;
      noticeTone.value = tone;
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => { notice.value = ''; }, 3600);
    }

    async function copy(value, message, key = '') {
      try {
        await navigator.clipboard.writeText(value);
        inform(message);
        copied.value = key;
        clearTimeout(copiedTimer);
        copiedTimer = setTimeout(() => { copied.value = ''; }, 1800);
      } catch {
        inform('复制权限不可用，请选中账号信息后手动复制。', 'warn');
      }
    }

    async function sync(alias) {
      if (syncing.has(alias) || !accounts.value.find(item => item.account === alias)?.ego_profile_bound) return;
      syncing.add(alias);
      syncErrors.delete(alias);
      try {
        const updated = await request('/api/sync', { account: alias });
        accounts.value = accounts.value.map(item => item.account === alias ? updated : item);
      } catch (error) { syncErrors.set(alias, error.message); }
      finally { syncing.delete(alias); }
    }

    function select(alias) {
      if (selected.value === alias) return;
      selected.value = alias;
      query.value = '';
      view.value = 'drafts';
      page.value = 1;
      copied.value = '';
      clearTimeout(copiedTimer);
    }

    async function load() {
      loading.value = true;
      loadError.value = '';
      try {
        const data = await request('/api/workspace');
        accounts.value = data.accounts;
        const first = data.accounts.find(item => item.ego_profile_bound) || data.accounts[0];
        if (first) select(first.account);
      } catch { loadError.value = '无法读取工作台数据。请检查本机服务后重试。'; }
      finally { loading.value = false; }
    }

    async function openDraft(row) {
      const alias = selected.value;
      opening.value = `${alias}:${row.key}`;
      try {
        await request('/api/open-draft', { account: alias, key: row.key });
        inform(`已在 ${alias} 对应的 Ego Profile 打开`);
      } catch (error) { inform(error.message, 'warn'); }
      finally { opening.value = ''; }
    }

    onMounted(load);
    onUnmounted(() => { clearTimeout(toastTimer); clearTimeout(copiedTimer); });
    watch([view, query], () => { page.value = 1; });
    watch(pages, count => { if (page.value > count) page.value = count; });

    function count(id) {
      if (id === 'drafts') return account.value?.drafts?.rows?.length;
      if (id === 'published') return account.value?.publications?.total;
      return account.value?.tasks?.length;
    }

    function rowMeta(row) {
      if (view.value === 'drafts') return row.id ? `草稿 ID ${row.id}` : '草稿';
      if (view.value === 'published') return row.date || '已发布';
      return [row.source_name, row.updated_at && formatTime(row.updated_at)].filter(Boolean).join(' · ') || '本地任务';
    }

    function chipTone(row) {
      if (row.status === 'verified') return 'ok';
      if (row.status === 'blocked' || row.needs_attention) return 'warn';
      if (row.status === 'running') return 'busy';
      return '';
    }

    function rowView(row, index) {
      const isDraft = view.value === 'drafts';
      const isPublished = view.value === 'published';
      const link = isPublished && articleLink(row.url);
      const rowKey = `${selected.value}:${row.key}`;
      return h('li', { key: isDraft ? (row.can_open ? row.key : `${row.key}:${index}`) : row.id || link || index, class: 'record' }, [
        h('span', { class: ['record-icon', `tone-${view.value}`], 'aria-hidden': 'true' },
          icon(isDraft ? 'draft' : isPublished ? 'published' : 'queue')),
        h('div', { class: 'record-body' }, [
          h('strong', { class: 'record-title' }, row.title),
          h('small', { class: 'record-meta' }, rowMeta(row)),
        ]),
        !isDraft && !isPublished && h('span', { class: ['chip', chipTone(row)], title: row.needs_attention ? '需要人工处理' : undefined },
          stages[row.status] || row.status),
        isDraft && button(opening.value === rowKey ? '正在打开…' : ['在 Ego 打开', icon('external')], {
          class: 'row-action',
          disabled: !row.can_open || !!opening.value || syncing.has(selected.value),
          title: row.can_open ? undefined : '列表有同名草稿，无法唯一定位',
          onClick: () => openDraft(row),
        }),
        link && h('a', { class: 'row-action', href: link, target: '_blank', rel: 'noreferrer' },
          ['查看原文', icon('external')]),
      ]);
    }

    function skeletonRows() {
      return h('div', { class: 'skeleton', 'aria-hidden': 'true' }, [0, 1, 2].map(index => h('div', { key: index, class: 'skeleton-row' }, [
        h('span', { class: 'skeleton-icon' }),
        h('span', { class: 'skeleton-lines' }, [
          h('span', { class: 'skeleton-bar w1' }),
          h('span', { class: 'skeleton-bar w2' }),
        ]),
      ])));
    }

    function emptyState() {
      const isQueue = view.value === 'queue';
      const bound = !!account.value.ego_profile_bound;
      const keyword = query.value.trim();
      let title;
      let desc;
      let action = null;
      if (keyword) {
        title = `没有匹配的${isQueue ? '任务' : '稿件'}`;
        desc = `标题中没有「${keyword}」，换个关键词试试。`;
        action = button('清除搜索', { class: 'action secondary', onClick: () => { query.value = ''; } });
      } else if (isQueue) {
        title = '队列里还没有任务';
        desc = '通过 CLI 或 Codex 提交的存稿任务会显示在这里。';
      } else if (!bound) {
        title = '这个账号还没有绑定 Ego';
        desc = '在终端为账号绑定 Ego Profile 后，即可同步头条草稿箱与已发布文章。';
      } else if (!activeSync.value?.synced_at) {
        title = '还没有同步过';
        desc = '点击「立即同步」，从 Ego 读取这个账号的头条草稿箱和已发布文章。';
        action = button([icon('sync'), '立即同步'], { class: 'action primary', onClick: () => sync(selected.value) });
      } else if (view.value === 'drafts') {
        title = '草稿箱是空的';
        desc = '在头条后台新建草稿后，回到这里同步即可看到。';
        action = button([icon('sync'), '重新同步'], { class: 'action secondary', onClick: () => sync(selected.value) });
      } else {
        title = '还没有已发布文章';
        desc = '在头条正式发布的文章会在同步后出现在这里。';
        action = button([icon('sync'), '重新同步'], { class: 'action secondary', onClick: () => sync(selected.value) });
      }
      return h('div', { class: 'empty-state' }, [
        h('span', { class: 'empty-icon', 'aria-hidden': 'true' }, icon(keyword ? 'search' : isQueue ? 'queue' : 'inbox')),
        h('p', { class: 'empty-title' }, title),
        h('p', { class: 'empty-desc' }, desc),
        action && h('div', { class: 'empty-action' }, action),
      ]);
    }

    function records() {
      const isSyncing = syncing.has(selected.value);
      const why = syncErrors.get(selected.value) || errors[activeSync.value?.sync_error] ||
        (activeSync.value?.sync_error ? '同步失败，请稍后重试。' : '');
      const metaText = view.value === 'queue' ? '本地任务队列'
        : isSyncing ? '正在从 Ego 同步…'
          : activeSync.value?.synced_at ? `上次同步 ${formatTime(activeSync.value.synced_at)}` : '尚未同步';
      const total = filtered.value.length;
      const showSkeleton = isSyncing && !list.value.length && view.value !== 'queue';
      return h('section', { class: 'card list-card', 'aria-labelledby': 'view-heading' }, [
        h('div', { class: 'list-toolbar' }, [
          h('div', { class: 'segmented', role: 'group', 'aria-label': '稿件来源' }, tabs.map(tab => button([
            h('span', tab.name),
            count(tab.id) != null ? h('span', { class: 'seg-count' }, String(count(tab.id))) : null,
          ], {
            key: tab.id, class: ['seg-tab', { selected: view.value === tab.id }],
            'aria-pressed': view.value === tab.id ? 'true' : 'false',
            onClick: () => { view.value = tab.id; },
          }))),
          h('label', { class: 'search' }, [
            icon('search'),
            h('input', {
              type: 'search', placeholder: '搜索标题', 'aria-label': '搜索稿件标题', value: query.value,
              onInput: event => { query.value = event.target.value; },
            }),
          ]),
        ]),
        h('div', { class: 'list-meta' }, [
          h('h2', { id: 'view-heading', class: 'sr-only' }, tabs.find(tab => tab.id === view.value).name),
          h('p', { class: 'sync-meta', role: 'status' }, [icon('clock'), metaText]),
          total ? h('span', { class: 'list-count' }, `共 ${total} 条`) : null,
        ]),
        why && view.value !== 'queue' && h('p', { class: 'sync-error', role: 'alert' }, [
          icon('alert'),
          h('span', activeSync.value?.synced_at ? `${why} 正在显示上次同步结果。` : why),
        ]),
        showSkeleton ? skeletonRows()
          : visible.value.length ? h('ul', { class: 'records' }, visible.value.map(rowView)) : emptyState(),
        pages.value > 1 && h('div', { class: 'pagination' }, [
          h('span', `第 ${page.value} / ${pages.value} 页`),
          h('div', { class: 'page-actions' }, [
            button([icon('chevronLeft'), '上一页'], {
              class: 'action small secondary', disabled: page.value === 1, onClick: () => page.value--,
            }),
            button(['下一页', icon('chevronRight')], {
              class: 'action small secondary', disabled: page.value === pages.value, onClick: () => page.value++,
            }),
          ]),
        ]),
      ]);
    }

    return () => h('div', { class: 'layout' }, [
      h(AccountNav, { accounts: accounts.value, selected: selected.value, select }),
      h('main', { class: 'workspace' }, [
        loading.value ? h('div', { class: 'boot', role: 'status' }, [h('span', { class: 'spinner' }), '正在读取本机账号…'])
          : loadError.value ? h('div', { class: 'card' }, [
            h('div', { class: 'empty-state standalone' }, [
              h('span', { class: 'empty-icon', 'aria-hidden': 'true' }, icon('alert')),
              h('p', { class: 'empty-title' }, '工作台没有打开'),
              h('p', { class: 'empty-desc', role: 'alert' }, loadError.value),
              h('div', { class: 'empty-action' }, button('重试', { class: 'action primary', onClick: load })),
            ]),
          ]) : account.value ? [
            h(AccountHeading, { account: account.value, copy, copied: copied.value, syncing: syncing.has(selected.value), sync }),
            h('div', { class: 'content-grid' }, [
              records(),
              h(AccountRail, { account: account.value, copy, copied: copied.value }),
            ]),
          ] : h('div', { class: 'card' }, [
            h('div', { class: 'empty-state standalone' }, [
              h('span', { class: 'empty-icon', 'aria-hidden': 'true' }, icon('user')),
              h('p', { class: 'empty-title' }, '还没有头条号账号'),
              h('p', { class: 'empty-desc' }, '先在本机绑定账号，再打开工作台。'),
            ]),
          ]),
      ]),
      h('div', { class: ['toast', noticeTone.value, { shown: notice.value }], role: 'status' }, [
        notice.value ? icon(noticeTone.value === 'warn' ? 'alert' : 'check') : null,
        h('span', notice.value),
      ]),
    ]);
  },
}).mount('#app');
