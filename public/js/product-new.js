/*
 * Add product page (views/product-new.xian): live summary, unit labels, box price, opening stock toggle
 * and a friendly check before submitting. The server validates everything again.
 */
(function () {
  'use strict';
  const form = document.getElementById('newProductForm');
  if (!form) return;
  const nf = new Intl.NumberFormat('en-PH');
  const peso = new Intl.NumberFormat('en-PH', { style: 'currency', currency: 'PHP' });
  const unitLabel = (unit, n) => (!unit || unit === 'piece') ? (n === 1 ? 'pc' : 'pcs') : (n === 1 ? unit : unit + 's');
  const $ = sel => form.querySelector(sel);
  const $$ = sel => Array.from(form.querySelectorAll(sel));
  const out = key => form.querySelector(`[data-out="${key}"]`);
  const opening = $('[data-opening]');
  const toggle = $('[data-opening-toggle]');

  const val = name => form.elements[name]?.value?.trim?.() ?? '';
  const unit = () => (form.querySelector('input[name="unit"]:checked') || {}).value || 'piece';
  const fmtDate = s => s ? new Date(s + 'T00:00:00').toLocaleDateString('en-PH', { year: 'numeric', month: 'short', day: 'numeric' }) : '';

  function refresh() {
    const u = unit();
    const price = Number(val('price')) || 0;
    const ppb = Number(val('piecesPerBox')) || 0;
    const reorder = Number(val('reorderLevel')) || 0;
    const qty = Number(val('quantity')) || 0;
    const inBoxes = (form.querySelector('input[name="openingUnit"]:checked') || {}).value === 'box';

    $$('[data-unit-suffix]').forEach(el => { el.textContent = '/ ' + unitLabel(u, 1); });
    $$('[data-unit-suffix-plural]').forEach(el => { el.textContent = unitLabel(u, 2); });

    // Box option only when a box size is set
    const boxOpt = $('[data-box-option]');
    boxOpt.classList.toggle('is-disabled', ppb < 1);
    boxOpt.querySelector('input').disabled = ppb < 1;
    if (ppb < 1 && inBoxes) form.querySelector('input[name="openingUnit"][value="piece"]').checked = true;

    $('[data-box-price]').textContent = ppb >= 1
      ? peso.format(price * ppb) + ' per box of ' + nf.format(ppb) + ' ' + unitLabel(u, ppb)
      : 'Set pieces per box to see it';

    out('name').textContent = val('name') || 'New product';
    out('category').textContent = val('category');
    out('price').textContent = peso.format(price);
    out('perUnit').textContent = '/ ' + unitLabel(u, 1);
    out('box').textContent = ppb >= 1 ? '1 box = ' + nf.format(ppb) + ' ' + unitLabel(u, ppb) + ' · ' + peso.format(price * ppb) : 'Not sold by box';
    out('reorder').textContent = nf.format(reorder) + ' ' + unitLabel(u, reorder);

    const pieces = (inBoxes && ppb >= 1) ? qty * ppb : qty;
    $('[data-qty-help]').textContent = inBoxes && ppb >= 1 && qty ? nf.format(qty) + ' box' + (qty === 1 ? '' : 'es') + ' = ' + nf.format(pieces) + ' ' + unitLabel(u, pieces) : '';
    if (toggle.checked && qty > 0) {
      const lot = val('batchNumber').toUpperCase();
      out('opening').textContent = nf.format(pieces) + ' ' + unitLabel(u, pieces) + (lot ? ' · Lot ' + lot : '') + (val('expiryDate') ? ' · exp ' + fmtDate(val('expiryDate')) : '');
    } else out('opening').textContent = toggle.checked ? 'Enter the quantity' : 'None, add later';

    const done = {
      name: !!val('name'),
      price: val('price') !== '' && price >= 0,
      opening: !toggle.checked || (qty > 0 && !!val('batchNumber') && !!val('expiryDate'))
    };
    Object.entries(done).forEach(([k, ok]) => form.querySelector(`[data-check="${k}"]`).classList.toggle('is-done', ok));
  }

  toggle.addEventListener('change', () => {
    opening.disabled = !toggle.checked; // disabled fields are not submitted -> no opening stock
    opening.closest('.np-card').classList.toggle('is-open', toggle.checked);
    if (toggle.checked) form.elements.batchNumber.focus();
    refresh();
  });
  form.addEventListener('input', refresh);
  form.addEventListener('change', refresh);

  form.addEventListener('submit', e => {
    const problems = [];
    if (!val('name')) problems.push(['name', 'Enter the product name.']);
    if (val('price') === '' || Number(val('price')) < 0) problems.push(['price', 'Enter the price per piece.']);
    if (toggle.checked) {
      if (!val('batchNumber')) problems.push(['batchNumber', 'Enter the lot number.']);
      if (!val('expiryDate')) problems.push(['expiryDate', 'Choose the expiry date.']);
      if (!(Number(val('quantity')) > 0)) problems.push(['quantity', 'Enter the opening quantity.']);
    }
    $$('.np-field.has-error').forEach(f => f.classList.remove('has-error'));
    if (!problems.length) return;
    e.preventDefault();
    problems.forEach(([name]) => form.elements[name].closest('.np-field').classList.add('has-error'));
    form.elements[problems[0][0]].focus();
    if (window.PharmaKeys?.toast) window.PharmaKeys.toast(problems.map(p => p[1]).join(' '));
  });

  refresh();
})();
