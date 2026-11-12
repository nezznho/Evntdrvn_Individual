/*
 * Pharma keyboard layer (vanilla JS, no dependencies).
 *  - one window "keydown" listener + a single shortcut registry (also renders the "?" help and the palette)
 *  - command palette (Ctrl/Cmd+K) backed by GET /api/search
 *  - USB barcode scanner detection backed by GET /api/products/by-barcode/:code
 *  - dialog focus management: focus first field, trap Tab, restore focus to the trigger on close
 * It drives the UI only through what already exists: sidebar links, [data-action] buttons and the
 * global functions in pharma.js (openModal/closeModal/openDispense/...). Mouse behaviour is unchanged.
 */
(function () {
  'use strict';
  if (window.PharmaKeys) return; // included twice? register nothing the second time

  const SEQ_TIMEOUT = 800;  // ms allowed between the two keys of "g i"
  const SCAN_GAP = 50;      // ms between scanner characters (humans are slower)
  const SCAN_MIN = 6;       // shortest code treated as a scan
  const HIGHLIGHT = ['ring-2', 'ring-inset', 'ring-indigo-400', 'bg-indigo-50'];
  const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform);

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const visible = el => !!el && el.getClientRects().length > 0;
  const onDashboard = location.pathname === '/dashboard';
  const isAdmin = () => $('.sidebar')?.dataset.userRole === 'admin';
  const NON_TEXT_INPUTS = ['button', 'submit', 'reset', 'checkbox', 'radio', 'range', 'color', 'file', 'image'];
  const isEditable = el => !!el && (el.isContentEditable ||
    el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' ||
    (el.tagName === 'INPUT' && !NON_TEXT_INPUTS.includes(el.type)));
  const isInteractive = el => !!el && el.matches('a[href], button, input, select, textarea, summary, [tabindex]:not([tabindex="-1"])');

  // ---------------------------------------------------------------- toasts (same look as the server flash)
  const toastBox = $('#kbToasts');
  function toast(message, { kind = 'error', link = null, timeout = 6000 } = {}) {
    if (!toastBox) return;
    const el = document.createElement('div');
    el.className = `flash flash-${kind} pointer-events-auto shadow-lg`;
    el.style.marginBottom = '0';
    el.textContent = (kind === 'error' ? '⚠ ' : kind === 'success' ? '✓ ' : '') + message + ' ';
    if (link) {
      const a = document.createElement('a');
      a.href = link.href; a.textContent = link.text; a.className = 'font-semibold underline';
      if (link.onClick) a.addEventListener('click', e => { e.preventDefault(); el.remove(); link.onClick(); });
      el.appendChild(a);
    }
    toastBox.appendChild(el);
    setTimeout(() => el.remove(), link ? timeout * 1.5 : timeout);
  }

  // ---------------------------------------------------------------- dialogs: focus in, trap, restore
  const palette = { el: $('#kbPalette'), input: $('#kbPaletteInput'), list: $('#kbPaletteList'), items: [], index: 0, remote: [], timer: 0, ctrl: null };
  const helpEl = $('#kbHelp');
  const triggers = new WeakMap();
  const isOpen = el => !!el && !el.classList.contains('hidden');
  const openModalEl = () => $$('.modal.open').pop() || null;
  const openLayer = () => [palette.el, helpEl].find(isOpen) || null;
  const activeDialog = () => openLayer() || openModalEl();
  const focusables = root => $$('a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])', root).filter(visible);

  function focusInto(dialog) {
    const all = focusables(dialog);
    (all.find(el => isEditable(el)) || all[0])?.focus();
  }
  function restoreFocus(dialog) {
    let target = triggers.get(dialog);
    triggers.delete(dialog);
    // The trigger may have been an item of a ⋮ menu that has closed since: fall back to that row's ⋮ button.
    if (target && !visible(target)) target = target.closest('tr')?.querySelector('[data-row-menu]');
    if (target && target.isConnected && visible(target)) target.focus({ preventScroll: true });
  }
  function showLayer(el) {
    if (!el || isOpen(el)) return;
    triggers.set(el, document.activeElement);
    el.classList.remove('hidden'); el.classList.add('flex');
  }
  function hideLayer(el) {
    if (!isOpen(el)) return;
    el.classList.add('hidden'); el.classList.remove('flex');
    restoreFocus(el);
  }
  [palette.el, helpEl].forEach(layer => layer?.addEventListener('mousedown', e => { if (e.target === layer) hideLayer(layer); }));
  $$('[data-kb-close]').forEach(btn => btn.addEventListener('click', () => hideLayer(btn.closest('.kb-layer'))));

  // pharma.js opens/closes modals and ⋮ menus by toggling the "open" class. Watching that class gives every
  // modal (mouse- or keyboard-opened) focus management and keeps aria-expanded in sync, without touching pharma.js.
  new MutationObserver(mutations => {
    for (const m of mutations) {
      const el = m.target;
      const was = (m.oldValue || '').split(/\s+/).includes('open');
      const now = el.classList.contains('open');
      if (was === now) continue;
      if (el.classList.contains('modal')) {
        if (now) { triggers.set(el, document.activeElement); requestAnimationFrame(() => focusInto(el)); }
        else restoreFocus(el);
      } else if (el.classList.contains('row-actions')) {
        el.previousElementSibling?.setAttribute('aria-expanded', String(now));
      }
    }
  }).observe(document.body, { subtree: true, attributes: true, attributeFilter: ['class'], attributeOldValue: true });

  function trapTab(e) {
    const dialog = activeDialog();
    if (!dialog) return;
    const items = focusables(dialog);
    if (!items.length) { e.preventDefault(); return; }
    const first = items[0], last = items[items.length - 1], active = document.activeElement;
    if (!dialog.contains(active)) { e.preventDefault(); first.focus(); }
    else if (e.shiftKey && active === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && active === last) { e.preventDefault(); first.focus(); }
  }

  // ---------------------------------------------------------------- navigation (same links the sidebar uses)
  const SECTION_NAMES = { overview: 'Overview', inventory: 'Inventory', batches: 'Batches / Lots', logs: 'Stock logs', staff: 'Staff', archive: 'Archive' };
  function go(name) {
    const link = $(`[data-nav="${name}"]`);
    if (!link) return toast(`${SECTION_NAMES[name] || name} is only available to admins.`);
    link.click();
  }
  function syncNav() {
    if (!onDashboard) return;
    const name = (location.hash || '#overview').slice(1);
    if (!$(`[data-nav="${name}"]`)) return;
    $$('[data-nav]').forEach(a => {
      const on = a.dataset.nav === name;
      a.classList.toggle('active', on);
      on ? a.setAttribute('aria-current', 'location') : a.removeAttribute('aria-current');
    });
  }

  // ---------------------------------------------------------------- table navigation
  let current = null; // highlighted <tr data-row>
  const rowsOf = kind => $$(`[data-table="${kind}"] tr[data-row]`).filter(r => r.style.display !== 'none');
  function sectionInView() {
    const mid = window.innerHeight / 2;
    for (const body of $$('[data-table]')) {
      const r = body.closest('section').getBoundingClientRect();
      if (r.top <= mid && r.bottom >= mid) return body.dataset.table;
    }
    return null;
  }
  function activeKind() {
    if (current?.isConnected) return current.dataset.row === 'lot' ? 'lots' : 'products';
    return sectionInView() || (location.hash === '#batches' ? 'lots' : 'products');
  }
  function highlight(row, { scroll = true } = {}) {
    if (current) { current.classList.remove(...HIGHLIGHT); current.removeAttribute('aria-selected'); }
    current = row || null;
    if (!current) return;
    current.classList.add(...HIGHLIGHT);
    current.setAttribute('aria-selected', 'true');
    if (scroll) current.scrollIntoView({ block: 'nearest' });
  }
  function moveRow(step) {
    const rows = rowsOf(activeKind());
    if (!rows.length) return false;
    let i = rows.indexOf(current);
    if (step === 'first') i = 0;
    else if (step === 'last') i = rows.length - 1;
    else if (i < 0) i = step > 0 ? 0 : rows.length - 1;
    else i = Math.min(rows.length - 1, Math.max(0, i + step));
    highlight(rows[i]);
  }
  const productRowById = id => $(`[data-table="products"] tr[data-id="${CSS.escape(String(id))}"]`);
  function productRow() {
    if (current?.dataset.row === 'product') return current;
    if (current?.dataset.row === 'lot') return productRowById(current.dataset.productId);
    return null;
  }
  function needRowHint(what) {
    if (!onDashboard) { location.href = '/dashboard#inventory'; return; }
    go('inventory');
    highlight(rowsOf('products')[0] || null);
    toast(`Pick a row with j / k, then press the key again to ${what}.`, { kind: 'info' });
  }
  function rowAction(action, what) {
    const row = productRow();
    if (!row) return needRowHint(what);
    const btn = row.querySelector(`[data-action="${action}"]`);
    if (!btn) return toast('Only admins can do that.');
    btn.click();
  }
  function openRow() {
    if (current.dataset.row === 'lot') return current.querySelector('[data-row-open]')?.click();
    // Products have no page of their own; their "details" are their lots, so show those.
    const name = current.dataset.name;
    const lotSearch = $('[data-search-input="lots"]');
    if (!lotSearch) return;
    lotSearch.value = name;
    lotSearch.dispatchEvent(new Event('input', { bubbles: true }));
    go('batches');
    const first = rowsOf('lots')[0];
    highlight(first || null);
    if (!first) toast(`${name} has no lots with stock on hand.`, { kind: 'info' });
  }
  function editRow() {
    if (!current) return needRowHint('edit it');
    if (current.dataset.row === 'lot') return toast('Lots can’t be edited. Press Enter to open the lot history, where it can be expired or recalled.', { kind: 'info' });
    const btn = current.querySelector('[data-action="edit-product"]');
    btn ? btn.click() : toast('Only admins can edit product details.');
  }
  function clearFilters() {
    $$('[data-search-input], [data-filter]').forEach(el => {
      if (!el.value) return;
      el.value = '';
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    });
  }
  function focusProduct(id) {
    const row = productRowById(id);
    if (!row) return false;
    if (row.style.display === 'none') clearFilters();
    go('inventory');
    highlight(row);
    return true;
  }

  // ---------------------------------------------------------------- ⋮ row menu
  const openMenu = () => $('.row-actions.open');
  const menuItems = () => { const m = openMenu(); return m ? $$('button', m).filter(visible) : []; };
  function openRowMenu() {
    if (!current) return needRowHint('open its actions');
    const btn = current.querySelector('[data-row-menu]');
    if (!btn) return toast('Lots have no actions menu. Press Enter to open the lot history.', { kind: 'info' });
    if (!btn.nextElementSibling.classList.contains('open')) btn.click(); // pharma.js toggleMenu()
    menuItems()[0]?.focus();
  }
  function moveMenu(step) {
    const items = menuItems();
    if (!items.length) return;
    let i = items.indexOf(document.activeElement);
    if (step === 'first') i = 0;
    else if (step === 'last') i = items.length - 1;
    else if (i < 0) i = step > 0 ? 0 : items.length - 1;
    else i = (i + step + items.length) % items.length;
    items[i].focus();
  }
  function closeMenu() {
    const m = openMenu();
    if (!m) return false;
    m.classList.remove('open');
    m.previousElementSibling?.focus();
    return true;
  }

  // ---------------------------------------------------------------- actions
  function addProduct(barcode = '') {
    const btn = $('[data-action="add-product"]');
    if (!btn) {
      if (!isAdmin()) return toast('Only admins can add products.');
      location.href = '/dashboard?' + new URLSearchParams(barcode ? { barcode } : { add: '1' });
      return;
    }
    btn.click(); // pharma.js openAddProduct()
    const form = $('#productModal form');
    if (barcode && form?.elements.barcode) form.elements.barcode.value = barcode;
  }
  function focusSearch() {
    const input = $(`[data-search-input="${activeKind()}"]`) || $('[data-search-input]');
    if (!input) return openPalette();
    input.focus();
    input.select();
  }
  function focusFilter() {
    const select = $('[data-filter="category"]');
    if (!select) { location.href = '/dashboard#inventory'; return; }
    select.focus();
  }
  function closeTopmost() {
    if (isOpen(palette.el)) return closePalette();
    if (isOpen(helpEl)) return hideLayer(helpEl);
    const modal = openModalEl();
    if (modal) return typeof window.closeModal === 'function' ? window.closeModal(modal.id) : modal.classList.remove('open');
    if (closeMenu()) return;
    const active = document.activeElement;
    if (isEditable(active)) return active.blur();
    if (current) return highlight(null);
    return false; // nothing to close: let the browser handle Esc
  }
  function toggleHelp() {
    if (isOpen(helpEl)) return hideLayer(helpEl);
    renderHelp();
    showLayer(helpEl);
    focusInto(helpEl);
  }

  // ---------------------------------------------------------------- the registry
  // keys: alternatives; "g i" = sequence; "mod" = Ctrl on Windows/Linux, Cmd on macOS.
  // scopes: where it is active: page | menu | modal | palette | help.  allowInInput: also fires while typing.
  // run() returning false means "not handled" (the browser default is kept). palette: listed in Ctrl+K.
  const registry = [
    { id: 'nav-overview', keys: ['g o'], description: 'Go to Overview', group: 'Navigation', scopes: ['page'], palette: true, run: () => go('overview') },
    { id: 'nav-inventory', keys: ['g i'], description: 'Go to Inventory', group: 'Navigation', scopes: ['page'], palette: true, run: () => go('inventory') },
    { id: 'nav-batches', keys: ['g b'], description: 'Go to Batches / Lots', group: 'Navigation', scopes: ['page'], palette: true, run: () => go('batches') },
    { id: 'nav-logs', keys: ['g l'], description: 'Go to Stock logs', group: 'Navigation', scopes: ['page'], palette: true, admin: true, run: () => go('logs') },
    { id: 'nav-staff', keys: ['g s'], description: 'Go to Staff', group: 'Navigation', scopes: ['page'], palette: true, admin: true, run: () => go('staff') },
    { id: 'nav-archive', keys: ['g a'], description: 'Go to Archive', group: 'Navigation', scopes: ['page'], palette: true, admin: true, run: () => go('archive') },

    { id: 'add-product', keys: ['n'], description: 'Add product', group: 'Actions', scopes: ['page'], palette: true, admin: true, keywords: 'new create', run: () => addProduct() },
    { id: 'stock-in', keys: ['r'], description: 'Receive stock (Stock In) for highlighted product', group: 'Actions', scopes: ['page'], palette: true, keywords: 'stock in delivery', run: () => rowAction('stock-in', 'receive stock') },
    { id: 'dispense', keys: ['d'], description: 'Dispense highlighted product', group: 'Actions', scopes: ['page'], palette: true, keywords: 'stock out sell', run: () => rowAction('dispense', 'dispense') },
    { id: 'search', keys: ['/'], description: 'Search the visible table', group: 'Actions', scopes: ['page'], palette: true, keywords: 'find filter', run: focusSearch },
    { id: 'filter', keys: ['f'], description: 'Filter inventory by category', group: 'Actions', scopes: ['page'], palette: true, run: focusFilter },
    { id: 'clear-filters', keys: [], description: 'Clear search and filters', group: 'Actions', scopes: ['page'], palette: true, run: clearFilters },
    { id: 'add-staff', keys: [], description: 'Add staff member', group: 'Actions', scopes: ['page'], palette: true, admin: true, run: () => { const b = $('[data-action="add-staff"]'); b ? b.click() : go('staff'); } },
    { id: 'logout', keys: [], description: 'Log out', group: 'Actions', scopes: ['page'], palette: true, keywords: 'sign out', run: () => $('[data-action="logout"]')?.click() },
    { id: 'palette', keys: ['mod+k'], description: 'Command palette', group: 'General', scopes: ['page', 'menu', 'palette'], allowInInput: true, run: () => (isOpen(palette.el) ? closePalette() : openPalette()) },
    { id: 'help', keys: ['?'], description: 'Show keyboard shortcuts', group: 'General', scopes: ['page', 'menu', 'help'], palette: true, run: toggleHelp },
    { id: 'escape', keys: ['escape'], description: 'Close dialog, palette or menu; else leave the field', group: 'General', scopes: ['page', 'menu', 'modal', 'palette', 'help'], allowInInput: true, run: closeTopmost },

    { id: 'row-next', keys: ['j', 'arrowdown'], description: 'Next row', group: 'Tables (Inventory, Lots)', scopes: ['page'],
      run: key => (key === 'arrowdown' && !current ? false : moveRow(1)) },
    { id: 'row-prev', keys: ['k', 'arrowup'], description: 'Previous row', group: 'Tables (Inventory, Lots)', scopes: ['page'],
      run: key => (key === 'arrowup' && !current ? false : moveRow(-1)) },
    { id: 'row-first', keys: ['home'], description: 'First row', group: 'Tables (Inventory, Lots)', scopes: ['page'], run: () => (current ? moveRow('first') : false) },
    { id: 'row-last', keys: ['end'], description: 'Last row', group: 'Tables (Inventory, Lots)', scopes: ['page'], run: () => (current ? moveRow('last') : false) },
    { id: 'row-open', keys: ['enter'], description: 'Open row (product → its lots, lot → history)', group: 'Tables (Inventory, Lots)', scopes: ['page'],
      run: () => (current && !isInteractive(document.activeElement) ? openRow() : false) },
    { id: 'row-edit', keys: ['e'], description: 'Edit highlighted product', group: 'Tables (Inventory, Lots)', scopes: ['page'], run: editRow },
    { id: 'row-menu', keys: ['.'], description: 'Open the row’s ⋮ actions menu', group: 'Tables (Inventory, Lots)', scopes: ['page'], run: openRowMenu },

    { id: 'menu-next', keys: ['arrowdown', 'j'], description: 'Next action', group: 'Row ⋮ menu', scopes: ['menu'], run: () => moveMenu(1) },
    { id: 'menu-prev', keys: ['arrowup', 'k'], description: 'Previous action', group: 'Row ⋮ menu', scopes: ['menu'], run: () => moveMenu(-1) },
    { id: 'menu-first', keys: ['home'], description: 'First action', group: 'Row ⋮ menu', scopes: ['menu'], run: () => moveMenu('first') },
    { id: 'menu-last', keys: ['end'], description: 'Last action', group: 'Row ⋮ menu', scopes: ['menu'], run: () => moveMenu('last') },
    { id: 'menu-run', keys: ['enter'], description: 'Run the focused action', group: 'Row ⋮ menu', scopes: ['menu'],
      run: () => (openMenu()?.contains(document.activeElement) ? false : moveMenu('first')) }, // false = native button click

    { id: 'pal-next', keys: ['arrowdown'], description: 'Next result', group: 'Command palette', scopes: ['palette'], allowInInput: true, run: () => selectPalette(palette.index + 1) },
    { id: 'pal-prev', keys: ['arrowup'], description: 'Previous result', group: 'Command palette', scopes: ['palette'], allowInInput: true, run: () => selectPalette(palette.index - 1) },
    { id: 'pal-run', keys: ['enter'], description: 'Run / open the selected result', group: 'Command palette', scopes: ['palette'], allowInInput: true, run: () => runPalette(palette.index) }
  ];

  // ---------------------------------------------------------------- key labels (<kbd>)
  const KEY_LABELS = { mod: IS_MAC ? '⌘' : 'Ctrl', shift: 'Shift', alt: IS_MAC ? '⌥' : 'Alt', arrowdown: '↓', arrowup: '↑', escape: 'Esc', enter: 'Enter', home: 'Home', end: 'End', space: 'Space' };
  function renderKeys(keys) {
    const frag = document.createDocumentFragment();
    keys.forEach((combo, n) => {
      if (n) frag.append(' or ');
      combo.split(' ').forEach((chord, c) => {
        if (c) frag.append(' then ');
        chord.split('+').forEach((part, p) => {
          if (p) frag.append('+');
          const kbd = document.createElement('kbd');
          kbd.textContent = KEY_LABELS[part] || (part.length === 1 && chord.includes('+') ? part.toUpperCase() : part);
          frag.append(kbd);
        });
      });
    });
    return frag;
  }
  function renderHelp() {
    const body = $('#kbHelpBody');
    if (!body) return;
    body.textContent = '';
    const groups = new Map();
    for (const s of registry) {
      if (!s.keys.length || (s.admin && !isAdmin())) continue;
      if (!groups.has(s.group)) groups.set(s.group, []);
      groups.get(s.group).push(s);
    }
    for (const [group, list] of groups) {
      const section = document.createElement('section');
      const h = document.createElement('h3');
      h.className = 'mb-2 text-[11px] font-semibold uppercase tracking-wider text-slate-400';
      h.textContent = group;
      const dl = document.createElement('dl');
      dl.className = 'space-y-1.5 text-sm';
      for (const s of list) {
        const row = document.createElement('div');
        row.className = 'flex items-center justify-between gap-4';
        const dt = document.createElement('dt'); dt.className = 'text-slate-600'; dt.textContent = s.description;
        const dd = document.createElement('dd'); dd.className = 'shrink-0 text-xs text-slate-400'; dd.append(renderKeys(s.keys));
        row.append(dt, dd);
        dl.append(row);
      }
      section.append(h, dl);
      body.append(section);
    }
  }

  // ---------------------------------------------------------------- command palette
  function fuzzy(query, text) {
    if (!query) return 1;
    const q = query.toLowerCase(), t = text.toLowerCase();
    const at = t.indexOf(q);
    if (at >= 0) return 1000 - at; // substring beats subsequence
    let from = 0, score = 0, streak = 0;
    for (const ch of q) {
      const found = t.indexOf(ch, from);
      if (found < 0) return 0;
      streak = found === from ? streak + 1 : 0;
      score += 1 + streak;
      from = found + 1;
    }
    return score;
  }
  const paletteCommands = () => registry.filter(s => s.palette && !(s.admin && !isAdmin()));

  function openPalette() {
    if (!palette.el) return;
    if (isOpen(helpEl)) hideLayer(helpEl);
    showLayer(palette.el);
    palette.input.value = '';
    palette.remote = [];
    palette.index = 0;
    renderPalette();
    palette.input.focus();
  }
  function closePalette() {
    clearTimeout(palette.timer);
    palette.ctrl?.abort();
    hideLayer(palette.el);
  }
  function renderPalette() {
    const q = palette.input.value.trim();
    const commands = paletteCommands()
      .map(s => ({ s, score: fuzzy(q, `${s.description} ${s.keywords || ''}`) }))
      .filter(x => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, q ? 6 : 20)
      .map(({ s }) => ({ group: 'Commands', label: s.description, keys: s.keys, run: () => s.run() }));
    const results = palette.remote
      .map(r => ({ r, score: fuzzy(q, r.label) || 1 }))
      .sort((a, b) => b.score - a.score)
      .map(({ r }) => ({ group: r.type === 'lot' ? 'Lots' : 'Products', label: r.label, detail: r.detail, run: () => openResult(r) }));
    palette.items = [...commands, ...results];

    const list = palette.list;
    list.textContent = '';
    let lastGroup = '';
    palette.items.forEach((item, i) => {
      if (item.group !== lastGroup) {
        lastGroup = item.group;
        const h = document.createElement('li');
        h.setAttribute('role', 'presentation');
        h.className = 'px-4 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wider text-slate-400';
        h.textContent = item.group;
        list.append(h);
      }
      const li = document.createElement('li');
      li.id = `kbOpt${i}`;
      li.dataset.index = i;
      li.setAttribute('role', 'option');
      li.className = 'mx-1 flex cursor-pointer items-center justify-between gap-3 rounded-md px-3 py-2 text-sm text-slate-700';
      const text = document.createElement('div');
      text.className = 'min-w-0';
      const label = document.createElement('div'); label.className = 'truncate'; label.textContent = item.label;
      text.append(label);
      if (item.detail) { const d = document.createElement('div'); d.className = 'truncate text-xs text-slate-400'; d.textContent = item.detail; text.append(d); }
      const right = document.createElement('span');
      right.className = 'shrink-0 text-xs text-slate-400';
      if (item.keys?.length) right.append(renderKeys(item.keys.slice(0, 1)));
      else if (item.group !== 'Commands') right.textContent = '↵ open';
      li.append(text, right);
      list.append(li);
    });
    if (!palette.items.length) {
      const empty = document.createElement('li');
      empty.className = 'px-4 py-6 text-center text-sm text-slate-400';
      empty.textContent = q ? 'No matching commands, products or lots.' : 'No commands available.';
      list.append(empty);
    }
    selectPalette(Math.min(palette.index, Math.max(0, palette.items.length - 1)));
  }
  function selectPalette(i) {
    const n = palette.items.length;
    if (!n) { palette.input.removeAttribute('aria-activedescendant'); return; }
    palette.index = (i + n) % n;
    $$('[role="option"]', palette.list).forEach(li => {
      const on = Number(li.dataset.index) === palette.index;
      li.setAttribute('aria-selected', String(on));
      li.classList.toggle('bg-indigo-50', on);
      li.classList.toggle('text-indigo-700', on);
      if (on) li.scrollIntoView({ block: 'nearest' });
    });
    palette.input.setAttribute('aria-activedescendant', `kbOpt${palette.index}`);
  }
  function runPalette(i) {
    const item = palette.items[i];
    if (!item) return;
    closePalette();
    item.run();
  }
  function openResult(r) {
    if (r.type === 'product' && focusProduct(r.id)) return;
    location.href = r.href;
  }
  function queueSearch() {
    clearTimeout(palette.timer);
    const q = palette.input.value.trim();
    if (!q) { palette.remote = []; renderPalette(); return; }
    palette.timer = setTimeout(async () => {
      palette.ctrl?.abort();
      palette.ctrl = new AbortController();
      try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`, { signal: palette.ctrl.signal, headers: { Accept: 'application/json' } });
        const data = await res.json().catch(() => null);
        if (!res.ok) throw new Error(data?.error || `Search failed (${res.status}).`);
        if (palette.input.value.trim() !== q) return; // a newer query is on its way
        palette.remote = Array.isArray(data) ? data : [];
        renderPalette();
      } catch (err) {
        if (err.name !== 'AbortError') toast(err.message || 'Search failed.');
      }
    }, 150);
  }
  if (palette.el) {
    palette.input.addEventListener('input', () => { palette.index = 0; renderPalette(); queueSearch(); });
    palette.list.addEventListener('mousedown', e => e.preventDefault()); // keep focus in the input
    palette.list.addEventListener('mousemove', e => {
      const li = e.target.closest('[role="option"]');
      if (li && Number(li.dataset.index) !== palette.index) selectPalette(Number(li.dataset.index));
    });
    palette.list.addEventListener('click', e => {
      const li = e.target.closest('[role="option"]');
      if (li) runPalette(Number(li.dataset.index));
    });
  }

  // ---------------------------------------------------------------- barcode scanner
  const scan = { buf: '', last: 0, target: null, snapshot: null };
  const resetScan = () => { scan.buf = ''; scan.target = null; scan.snapshot = null; };
  let pending = 0; // timer of a deferred single-key shortcut (cancelled if the key turns out to be part of a scan)
  const cancelPending = () => { clearTimeout(pending); pending = 0; };

  // Returns true when the event was consumed by the scanner logic.
  function trackScan(e, now) {
    if (e.repeat) { resetScan(); return false; }
    const printable = e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey;
    if (printable) {
      if (now - scan.last > SCAN_GAP) {
        resetScan();
        scan.target = e.target;
        scan.snapshot = isEditable(e.target) && 'value' in e.target ? e.target.value : null;
      }
      scan.buf += e.key;
      scan.last = now;
      if (scan.buf.length === 2) cancelPending();          // 2 keys in <50ms: not a single-key shortcut (but may finish "g i")
      if (scan.buf.length >= 3) {                           // 3+ keys in <50ms: a scanner, not a person
        cancelPending(); seq = null;
        if (!isEditable(e.target)) e.preventDefault();
        return true;
      }
      return false;
    }
    if (e.key === 'Enter' && scan.buf.length >= SCAN_MIN && now - scan.last <= SCAN_GAP * 2) {
      const code = scan.buf.trim(), target = scan.target, snapshot = scan.snapshot;
      resetScan();
      e.preventDefault();
      e.stopPropagation();
      if (target?.hasAttribute?.('data-scan-accept')) return true; // e.g. Add product > Barcode: keep the text, don't submit
      if (isEditable(target) && snapshot !== null) {              // undo the characters the scanner typed into the field
        target.value = snapshot;
        target.dispatchEvent(new Event('input', { bubbles: true }));
      }
      handleScan(code);
      return true;
    }
    if (e.key !== 'Shift') resetScan();
    return false;
  }

  async function handleScan(code) {
    if (!code) return;
    const dispense = $('#dispenseModal.open');
    const otherModal = openModalEl();
    if (otherModal && !dispense) return toast(`Scanned ${code}. Close the open dialog to look it up.`, { kind: 'info' });
    if (isOpen(palette.el)) closePalette();
    if (isOpen(helpEl)) hideLayer(helpEl);

    // Dispense form open + the code is one of the offered lot numbers -> pick that lot.
    if (dispense) {
      const select = $('#dispenseLot');
      const opt = select && Array.from(select.options).find(o => o.value && o.text.split(' · ')[0].toUpperCase() === code.toUpperCase());
      if (opt) {
        select.value = opt.value;
        select.dispatchEvent(new Event('change', { bubbles: true }));
        return toast(`Lot ${code.toUpperCase()} selected.`, { kind: 'success' });
      }
    }

    let product = null;
    try {
      const res = await fetch(`/api/products/by-barcode/${encodeURIComponent(code)}`, { headers: { Accept: 'application/json' } });
      const data = await res.json().catch(() => null);
      if (res.ok) product = data;
      else if (res.status !== 404) throw new Error(data?.error || `Barcode lookup failed (${res.status}).`);
    } catch (err) {
      return toast(err.message || 'Barcode lookup failed.');
    }

    if (!product) {
      if (!isAdmin()) return toast(`No product with barcode ${code}. Ask an admin to add it.`);
      const inPlace = $('[data-action="add-product"]') ? () => addProduct(code) : null; // already on the dashboard: no reload
      return toast(`No product with barcode ${code}.`, { link: { href: `/dashboard?barcode=${encodeURIComponent(code)}`, text: 'Add product with this barcode', onClick: inPlace } });
    }

    if (dispense) {
      const row = productRowById(product.id);
      const form = $('#dispenseForm');
      if (row && form && typeof window.openDispense === 'function') {
        if (form.getAttribute('action') === `/products/${product.id}/dispense`) return toast(`${product.label} is already selected.`, { kind: 'info' });
        const qty = form.elements.quantity.value;
        window.openDispense(row.querySelector('[data-action="dispense"]'));
        form.elements.quantity.value = qty;
        form.elements.quantity.focus();
        return toast(`Switched to ${product.label}.`, { kind: 'success' });
      }
    }
    if (focusProduct(product.id)) return toast(`Scanned: ${product.label}`, { kind: 'success' });
    location.href = product.href;
  }

  // ---------------------------------------------------------------- dispatcher (the one keydown listener)
  let seq = null, seqAt = 0;
  function currentScope() {
    if (isOpen(palette.el)) return 'palette';
    if (isOpen(helpEl)) return 'help';
    if (openModalEl()) return 'modal';
    if (openMenu()) return 'menu';
    return 'page';
  }
  function comboOf(e) {
    let key = e.key === ' ' ? 'space' : e.key.toLowerCase();
    const parts = [];
    if (e.ctrlKey || e.metaKey) parts.push('mod');
    if (e.altKey) parts.push('alt');
    if (e.shiftKey && (key.length > 1 || /^[a-z]$/.test(key))) parts.push('shift'); // "?" already implies Shift
    parts.push(key);
    return parts.join('+');
  }
  function fire(entry, e, combo) {
    // Single printable keys wait SCAN_GAP ms so a barcode scan starting with e.g. "n" never opens a dialog.
    if (combo.length === 1 && !e.repeat) {
      e.preventDefault();
      cancelPending();
      pending = setTimeout(() => { pending = 0; entry.run(combo); }, SCAN_GAP);
      return;
    }
    if (entry.run(combo, e) !== false) e.preventDefault();
  }
  function onKeyDown(e) {
    if (e.defaultPrevented || e.isComposing || ['Shift', 'Control', 'Alt', 'Meta'].includes(e.key)) return;
    const now = e.timeStamp || performance.now();
    if (trackScan(e, now)) return;
    if (e.key === 'Tab') { trapTab(e); return; }

    const scope = currentScope();
    const typing = isEditable(e.target);
    const combo = comboOf(e);
    const usable = s => s.scopes.includes(scope) && (!typing || s.allowInInput);

    let entry = null;
    const hadSeq = seq && now - seqAt <= SEQ_TIMEOUT;
    if (hadSeq) entry = registry.find(s => usable(s) && s.keys.includes(`${seq} ${combo}`));
    seq = null;
    if (!entry) entry = registry.find(s => usable(s) && s.keys.includes(combo));
    if (entry) return fire(entry, e, combo);
    if (registry.some(s => usable(s) && s.keys.some(k => k.startsWith(combo + ' ')))) {
      seq = combo; seqAt = now;
      e.preventDefault();
    }
  }
  window.addEventListener('keydown', onKeyDown);

  // ---------------------------------------------------------------- page wiring
  window.addEventListener('hashchange', () => {
    const section = document.getElementById(location.hash.slice(1));
    if (current && section && !section.contains(current)) highlight(null);
    syncNav();
  });
  // Mouse and keyboard mix: clicking a row makes it the highlighted row.
  document.addEventListener('click', e => {
    const row = e.target.closest?.('tr[data-row]');
    if (row) highlight(row, { scroll: false });
  });
  // Filtering can hide the highlighted row.
  ['input', 'change'].forEach(type => document.addEventListener(type, e => {
    if (e.target.matches?.('[data-search-input], [data-filter]') && current?.style.display === 'none') highlight(null);
  }));

  // Deep links: /dashboard?product=ID (palette/scanner), ?barcode=CODE or ?add=1 (open Add product).
  function handleDeepLink() {
    if (!onDashboard || !location.search) return;
    const params = new URLSearchParams(location.search);
    const product = params.get('product'), barcode = params.get('barcode'), add = params.get('add');
    ['product', 'barcode', 'add'].forEach(k => params.delete(k));
    const rest = params.toString();
    history.replaceState(null, '', location.pathname + (rest ? `?${rest}` : '') + location.hash);
    if (barcode !== null || add !== null) addProduct(barcode || '');
    else if (product && !focusProduct(product)) toast('That product is not in active inventory (it may be archived).');
  }

  syncNav();
  handleDeepLink();

  window.PharmaKeys = { registry, openPalette, toast, highlight };
})();
