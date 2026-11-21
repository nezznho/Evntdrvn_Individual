/*
 * Overview inventory analytics (vanilla JS). Fetches GET /api/dashboard/stats and renders two Chart.js
 * charts (vendored at /js/vendor/chart.umd.min.js) and three tables, without a page reload.
 * Sales figures are not shown here: they belong to the POS system.
 * Loads the first time the Overview view is shown (see views.js 'pharma:viewchange').
 */
(function () {
  'use strict';
  const root = document.getElementById('analytics');
  if (!root || window.PharmaAnalytics) return;

  // ---------------------------------------------------------------- formatting (same options as helpers/format.js)
  const peso = new Intl.NumberFormat('en-PH', { style: 'currency', currency: 'PHP' });
  const pesoCompact = new Intl.NumberFormat('en-PH', { style: 'currency', currency: 'PHP', notation: 'compact', maximumFractionDigits: 1 });
  const int = new Intl.NumberFormat('en-PH');
  const dec = new Intl.NumberFormat('en-PH', { maximumFractionDigits: 1 });
  const fmtMoney = v => peso.format(Number(v) || 0);
  const fmtDate = iso => new Date(iso).toLocaleDateString('en-PH', { year: 'numeric', month: 'short', day: 'numeric' });
  const fmtYmd = ymd => { const [y, m, d] = ymd.split('-').map(Number); return new Date(y, m - 1, d).toLocaleDateString('en-PH', { year: 'numeric', month: 'short', day: 'numeric' }); };

  // ---------------------------------------------------------------- palette (validated categorical order, light surface)
  const SERIES = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#6250d6'];
  const OTHER = '#a3a9b5';
  const INK = '#475569', MUTED = '#8d95a5', GRID = '#eef1f5', SURFACE = '#ffffff';

  const $ = sel => document.querySelector(sel);
  const $$ = sel => Array.from(document.querySelectorAll(sel));
  const status = $('#anStatus');
  const form = $('#anRangeForm');
  const state = { range: 'daily', from: '', to: '', loaded: false, ctrl: null, charts: {}, data: null };

  function setStatus(text, isError = false) {
    status.textContent = text;
    status.classList.toggle('error', isError);
  }

  // ---------------------------------------------------------------- loading
  async function load() {
    state.ctrl?.abort();
    const ctrl = state.ctrl = new AbortController();
    const params = new URLSearchParams({ range: state.range });
    if (state.from) params.set('from', state.from);
    if (state.to) params.set('to', state.to);
    root.setAttribute('aria-busy', 'true');
    setStatus('Loading…');
    try {
      const res = await fetch('/api/dashboard/stats?' + params, { headers: { Accept: 'application/json' }, credentials: 'same-origin', signal: ctrl.signal });
      const body = await res.json().catch(() => ({}));
      if (res.status === 401) { setStatus(body.error || 'Session ended. Please sign in again.', true); return; }
      if (!res.ok) { setStatus(body.error || 'Could not load inventory data.', true); return; }
      state.data = body;
      state.loaded = true;
      render(body);
      setStatus('Updated ' + new Date().toLocaleTimeString('en-PH', { hour: 'numeric', minute: '2-digit' }));
    } catch (err) {
      if (err.name !== 'AbortError') setStatus('Could not load inventory data. Check the connection and try again.', true);
    } finally {
      if (state.ctrl === ctrl) root.removeAttribute('aria-busy');
    }
  }

  // ---------------------------------------------------------------- rendering
  function render(d) {
    const rangeText = d.from === d.to ? fmtYmd(d.from) : `${fmtYmd(d.from)} – ${fmtYmd(d.to)}`;
    $$('[data-range-label]').forEach(el => { el.textContent = rangeText; });
    renderMovementChart(d);
    renderCategoryChart(d);
    renderDaysOfStock(d);
    renderSlowMovers(d);
    renderExpiryRisk(d);
  }

  // ---------------------------------------------------------------- charts
  const hasChart = () => typeof window.Chart === 'function';
  if (hasChart()) {
    Chart.defaults.font.family = 'Inter, Arial, sans-serif';
    Chart.defaults.font.size = 11;
    Chart.defaults.color = MUTED;
  }
  const baseTooltip = {
    backgroundColor: '#1e293b', titleColor: '#fff', bodyColor: '#e2e8f0', padding: 10, cornerRadius: 6,
    boxPadding: 4, usePointStyle: true
  };
  const axes = money => ({
    x: { grid: { display: false }, border: { color: GRID }, ticks: { color: MUTED, maxRotation: 0, autoSkip: true, autoSkipPadding: 12 } },
    y: {
      beginAtZero: true, grid: { color: GRID }, border: { display: false },
      ticks: { color: MUTED, maxTicksLimit: 6, callback: v => (money ? pesoCompact.format(v) : int.format(v)) }
    }
  });

  function showEmpty(key, canvas, empty, message) {
    const el = $(`[data-empty="${key}"]`);
    if (message) el.textContent = message;
    el.hidden = !empty;
    canvas.style.visibility = empty ? 'hidden' : '';
  }

  function upsert(key, canvas, config) {
    const chart = state.charts[key];
    if (!chart) { state.charts[key] = new Chart(canvas, config); return; }
    chart.data = config.data;
    chart.options = config.options;
    chart.update();
  }

  function chartsUnavailable() {
    ['movement', 'category'].forEach(k => {
      const el = $(`[data-empty="${k}"]`);
      el.textContent = 'Charts could not be loaded (missing /js/vendor/chart.umd.min.js).';
      el.hidden = false;
    });
  }

  function renderMovementChart(d) {
    const canvas = $('#movementChart');
    const empty = d.movementSeries.every(p => !p.in && !p.out);
    showEmpty('movement', canvas, empty);
    if (!hasChart()) return;
    const bar = (label, color, key) => ({
      label, data: d.movementSeries.map(p => p[key]), backgroundColor: color,
      borderRadius: 4, borderSkipped: 'start', categoryPercentage: 0.7, barPercentage: 0.9, maxBarThickness: 22
    });
    upsert('movement', canvas, {
      type: 'bar',
      data: { labels: d.movementSeries.map(p => p.label), datasets: [bar('Stock in', SERIES[0], 'in'), bar('Stock out', SERIES[1], 'out')] },
      options: {
        maintainAspectRatio: false, animation: { duration: 250 },
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { position: 'top', align: 'end', labels: { color: INK, usePointStyle: true, pointStyle: 'rectRounded', boxWidth: 8, boxHeight: 8 } },
          tooltip: { ...baseTooltip, callbacks: { label: c => ` ${c.dataset.label}: ${int.format(c.parsed.y)} units` } }
        },
        scales: axes(false)
      }
    });
  }

  function renderCategoryChart(d) {
    const canvas = $('#categoryChart');
    // Fixed hue order by category value; anything past 7 categories folds into "Other" (never a generated 8th hue).
    let rows = d.categoryValue.slice();
    if (rows.length > SERIES.length) {
      const rest = rows.slice(SERIES.length - 1);
      rows = rows.slice(0, SERIES.length - 1).concat([{ category: 'Other', value: rest.reduce((s, r) => s + r.value, 0), other: true }]);
    }
    showEmpty('category', canvas, !rows.length);
    if (!hasChart()) return;
    const total = rows.reduce((s, r) => s + r.value, 0) || 1;
    upsert('category', canvas, {
      type: 'doughnut',
      data: {
        labels: rows.map(r => r.category),
        datasets: [{
          data: rows.map(r => r.value),
          backgroundColor: rows.map((r, i) => (r.other ? OTHER : SERIES[i])),
          borderColor: SURFACE, borderWidth: 2, hoverOffset: 4
        }]
      },
      options: {
        maintainAspectRatio: false, cutout: '62%', animation: { duration: 250 },
        plugins: {
          legend: { position: 'bottom', labels: { color: INK, usePointStyle: true, pointStyle: 'circle', boxWidth: 8, boxHeight: 8, padding: 10 } },
          tooltip: { ...baseTooltip, callbacks: { label: c => ` ${c.label}: ${fmtMoney(c.parsed)} (${dec.format((c.parsed / total) * 100)}%)` } }
        }
      }
    });
  }

  // ---------------------------------------------------------------- tables (DOM nodes only, so product names are never parsed as HTML)
  function cell(content, cls) {
    const td = document.createElement('td');
    if (cls) td.className = cls;
    if (content instanceof Node) td.appendChild(content); else td.textContent = content;
    return td;
  }
  function fill(tbodyId, rows, emptyText, colspan) {
    const tbody = document.getElementById(tbodyId);
    tbody.textContent = '';
    if (!rows.length) {
      const tr = document.createElement('tr');
      const td = cell(emptyText, 'empty');
      td.colSpan = colspan;
      tr.appendChild(td);
      tbody.appendChild(tr);
      return;
    }
    rows.forEach(tr => tbody.appendChild(tr));
  }
  function tr(cells, cls) {
    const row = document.createElement('tr');
    if (cls) row.className = cls;
    cells.forEach(c => row.appendChild(c));
    return row;
  }
  function strong(text) { const b = document.createElement('b'); b.textContent = text; return b; }

  function renderDaysOfStock(d) {
    fill('anDaysOfStock', d.daysOfStock.map(p => {
      const days = document.createElement('span');
      days.className = 'days';
      let rowCls = '';
      if (p.daysLeft === null) {
        days.textContent = '—';
        days.title = 'Nothing dispensed in the last 30 days';
      } else {
        days.textContent = dec.format(p.daysLeft);
        const tag = document.createElement('small');
        if (p.daysLeft < 14) { rowCls = 'row-crit'; tag.textContent = '⚠ Reorder now'; days.appendChild(tag); }
        else if (p.daysLeft < 30) { rowCls = 'row-warn'; tag.textContent = 'Reorder soon'; days.appendChild(tag); }
      }
      return tr([cell(strong(p.product)), cell(int.format(p.qty), 'num'), cell(dec.format(p.avgDailyOut), 'num'), cell(days, 'num')], rowCls);
    }), 'No active products.', 4);
  }

  function renderSlowMovers(d) {
    fill('anSlowMovers', d.slowMovers.map(p => tr([
      cell(strong(p.product)), cell(int.format(p.qty), 'num'), cell(fmtMoney(p.value), 'num'),
      cell(p.lastOut ? fmtDate(p.lastOut) : 'Never', p.lastOut ? '' : 'muted')
    ])), 'No slow movers. Everything in stock was dispensed in the last 60 days.', 4);
  }

  function renderExpiryRisk(d) {
    fill('anExpiryRisk', [30, 60, 90].map(days => {
      const r = d.expiryRisk['d' + days];
      return tr([cell(strong(`Within ${days} days`)), cell(int.format(r.lots), 'num'), cell(int.format(r.units), 'num'), cell(fmtMoney(r.value), 'num')], r.value > 0 && days === 30 ? 'row-crit' : '');
    }), '', 4);
  }

  // ---------------------------------------------------------------- controls
  $$('[data-range]').forEach(btn => btn.addEventListener('click', () => {
    state.range = btn.dataset.range;
    $$('[data-range]').forEach(b => b.setAttribute('aria-pressed', String(b === btn)));
    load();
  }));
  form.addEventListener('submit', e => {
    e.preventDefault();
    const from = form.elements.from.value, to = form.elements.to.value;
    if (from && to && from > to) { setStatus('“From” must be on or before “To”.', true); return; }
    state.from = from; state.to = to;
    load();
  });
  form.querySelector('[data-range-clear]').addEventListener('click', () => {
    form.reset();
    if (!state.from && !state.to) return;
    state.from = state.to = '';
    load();
  });

  // ---------------------------------------------------------------- lifecycle
  const onOverview = () => !window.PharmaViews || window.PharmaViews.current() === 'overview';
  document.addEventListener('pharma:viewchange', e => { if (e.detail.view === 'overview' && !state.loaded) load(); });
  if (onOverview()) load();

  window.PharmaAnalytics = { reload: load, fmtMoney };
})();
