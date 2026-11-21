/*
 * Dashboard view switcher (vanilla JS). Exactly one <section data-view="..."> is visible at a time,
 * chosen by the URL hash: /dashboard#inventory, #lots, #logs, #categories, #suppliers, #staff, #archive (default #overview).
 * Sections ship with the `hidden` attribute, so nothing flashes before this runs; it is loaded right
 * after <main> and runs synchronously. Old links (#batches) are aliases. Unknown hashes fall back to Overview.
 *
 * Other scripts:  PharmaViews.show('inventory')   switch view (and push a history entry)
 *                 document 'pharma:viewchange'    event with detail { view, previous }
 */
(function () {
  'use strict';
  if (window.PharmaViews) return;

  const DEFAULT = 'overview';
  const ALIASES = { batches: 'lots' };
  const sections = Array.from(document.querySelectorAll('section[data-view]'));
  if (!sections.length) return;
  const byName = new Map(sections.map(s => [s.dataset.view, s]));
  const heading = document.querySelector('[data-view-heading]');
  let current = null;

  // '#batches' -> 'lots'; returns null for unknown or empty hashes.
  function resolve(hash) {
    let name = String(hash || '').replace(/^#/, '');
    try { name = decodeURIComponent(name); } catch (_) { /* keep raw */ }
    name = ALIASES[name] || name;
    return byName.has(name) ? name : null;
  }

  function render(name, { scroll = true } = {}) {
    if (!byName.has(name)) name = DEFAULT;
    if (name === current) return name;
    const previous = current;
    current = name;

    byName.forEach((section, key) => { section.hidden = key !== name; });
    document.querySelectorAll('[data-nav]').forEach(link => {
      const on = link.dataset.nav === name;
      link.classList.toggle('active', on);
      if (on) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current');
    });
    const title = byName.get(name).dataset.viewTitle || name;
    document.title = `${title} – Pharma`;
    if (heading) heading.textContent = name === DEFAULT ? 'Dashboard' : title;
    // A ⋮ menu left open in the previous view would float over the new one.
    document.querySelectorAll('.row-actions.open').forEach(m => m.classList.remove('open'));
    if (scroll) window.scrollTo(0, 0);

    document.dispatchEvent(new CustomEvent('pharma:viewchange', { detail: { view: name, previous } }));
    return name;
  }

  function fromHash() {
    const raw = location.hash.slice(1);
    const name = resolve(raw);
    // In-page anchors that are not views (e.g. the "Skip to content" link -> #main-content) keep the current view.
    if (!name && raw && current && document.getElementById(raw)) return;
    render(name || DEFAULT);
    // Normalise aliases and junk so the address bar matches what is shown (#batches -> #lots).
    if (raw && raw !== current && !document.getElementById(raw)) {
      history.replaceState(history.state, '', location.pathname + location.search + '#' + current);
    }
  }

  // Programmatic navigation (keyboard shortcuts): show synchronously, then record it in history.
  function show(name) {
    const target = resolve(name);
    if (!target) return false;
    render(target);
    if (location.hash.slice(1) !== target) history.pushState(history.state, '', location.pathname + location.search + '#' + target);
    return true;
  }

  window.addEventListener('hashchange', fromHash);
  window.addEventListener('popstate', fromHash); // back/forward between entries created by show()
  fromHash();

  window.PharmaViews = {
    show,
    current: () => current,
    has: name => resolve(name) !== null,
    names: Array.from(byName.keys())
  };
})();
