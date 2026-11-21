function openModal(id) { document.getElementById(id).classList.add('open'); }
function closeModal(id) { document.getElementById(id).classList.remove('open'); }
document.querySelectorAll('.modal').forEach(m => m.addEventListener('click', e => { if (e.target === m) m.classList.remove('open'); }));

function toggleMenu(button) {
  document.querySelectorAll('.row-actions').forEach(x => { if (x !== button.nextElementSibling) x.classList.remove('open'); });
  button.nextElementSibling.classList.toggle('open');
}
document.addEventListener('click', e => {
  if (!e.target.matches('.row-menu')) document.querySelectorAll('.row-actions').forEach(x => x.classList.remove('open'));
});

// Product data is read from the row's data-* attributes, so names with quotes or apostrophes are safe.
const rowOf = el => el.closest('tr');

// ---------- Pieces / boxes ----------
// Stock is kept in pieces. A form's quantity may be entered in boxes; the preview shows the pieces and the
// product total before -> after, so staff can see how much the stock grows before saving.
const nf = new Intl.NumberFormat('en-PH');
const unitLabel = (unit, n) => (!unit || unit === 'piece') ? (n === 1 ? 'pc' : 'pcs') : (n === 1 ? unit : unit + 's');

function setupQty(form, { unit, ppb, current, sign, maxPieces }) {
  const qty = form.querySelector('[data-qty]');
  const unitSel = form.querySelector('[data-qty-unit]');
  const preview = form.querySelector('[data-qty-preview]');
  const per = Number(ppb) || 0;
  if (unitSel) {
    const boxOpt = unitSel.querySelector('option[value="box"]');
    boxOpt.disabled = per < 1;
    boxOpt.textContent = per >= 1 ? 'Boxes (1 box = ' + nf.format(per) + ' ' + unitLabel(unit, per) + ')' : 'Boxes (set pieces per box first)';
    if (boxOpt.disabled) unitSel.value = 'piece'; // form.reset() already starts each dialog on pieces
  }
  const update = () => {
    const isBox = unitSel?.value === 'box';
    const n = Number(qty.value) || 0;
    const pieces = isBox ? n * per : n;
    if (maxPieces !== undefined) qty.max = isBox ? Math.floor(maxPieces / Math.max(per, 1)) : maxPieces;
    if (!preview) return;
    if (!n) { preview.textContent = current === undefined ? '' : 'Current stock: ' + nf.format(current) + ' ' + unitLabel(unit, current) + '.'; return; }
    const head = isBox ? nf.format(n) + ' box' + (n === 1 ? '' : 'es') + ' = ' + nf.format(pieces) + ' ' + unitLabel(unit, pieces) + '. ' : '';
    if (current === undefined) { preview.textContent = head; return; }
    const after = current + sign * pieces;
    const growth = sign > 0 ? (current > 0 ? ' (+' + nf.format(Math.round(pieces / current * 1000) / 10) + '%)' : ' (new stock)') : '';
    preview.textContent = head + 'Stock: ' + nf.format(current) + ' → ' + nf.format(after) + ' ' + unitLabel(unit, after) + growth + '.';
  };
  qty.oninput = update;
  if (unitSel) unitSel.onchange = update;
  update();
}

function openStockIn(btn) {
  const row = rowOf(btn);
  const form = document.getElementById('stockForm');
  form.reset();
  form.action = '/products/' + row.dataset.id + '/stock';
  document.getElementById('stockTitle').textContent = 'Receive stock: ' + row.dataset.name;
  form.elements.expiryDate.min = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  setupQty(form, { unit: row.dataset.unit, ppb: row.dataset.ppb, current: Number(row.dataset.qty) || 0, sign: 1 });
  openModal('stockModal');
}

function openDispense(btn) {
  const row = rowOf(btn);
  const lots = JSON.parse(row.dataset.lots || '[]');
  const form = document.getElementById('dispenseForm');
  form.reset();
  form.action = '/products/' + row.dataset.id + '/stock-out';
  document.getElementById('dispenseTitle').textContent = 'Stock out: ' + row.dataset.name;
  document.getElementById('dispenseAvail').textContent = lots.length
    ? row.dataset.sellable + ' unexpired unit(s) available across ' + lots.length + ' lot(s).'
    : 'No unexpired stock available.';
  const select = document.getElementById('dispenseLot');
  select.innerHTML = '';
  select.add(new Option('Auto (FEFO: earliest expiry first)', ''));
  const unit = row.dataset.unit;
  lots.forEach(l => select.add(new Option(l.lot + ' · ' + nf.format(l.qty) + ' ' + unitLabel(unit, l.qty) + ' · exp ' + l.exp, l.id)));
  const sellable = Number(row.dataset.sellable) || 0;
  const options = { unit, ppb: row.dataset.ppb, current: Number(row.dataset.qty) || 0, sign: -1, maxPieces: sellable };
  setupQty(form, options);
  // Picking one lot limits the maximum to that lot's quantity
  select.onchange = () => {
    const lot = lots.find(l => String(l.id) === select.value);
    setupQty(form, { ...options, maxPieces: lot ? lot.qty : sellable });
  };
  openModal('dispenseModal');
}

function openProductEdit(btn) {
  const row = rowOf(btn);
  const form = document.querySelector('#productModal form');
  form.reset();
  form.action = '/products/' + row.dataset.id + '/edit';
  form.querySelector('h2').textContent = 'Edit product: ' + row.dataset.name;
  form.elements.name.value = row.dataset.name;
  form.elements.unit.value = row.dataset.unit || 'piece';
  form.elements.piecesPerBox.value = row.dataset.ppb || '';
  form.elements.reorderLevel.value = row.dataset.reorder || 25;
  form.elements.category.value = row.dataset.category;
  form.elements.price.value = row.dataset.price;
  form.elements.barcode.value = row.dataset.barcode || '';
  openModal('productModal');
}

// Add / edit supplier (Suppliers view). Without a row it opens empty for a new supplier.
function openSupplier(btn) {
  const form = document.getElementById('supplierForm');
  form.reset();
  const row = btn ? btn.closest('tr') : null;
  form.action = row ? '/suppliers/' + row.dataset.supplier + '/edit' : '/suppliers';
  document.getElementById('supplierTitle').textContent = row ? 'Edit supplier: ' + row.dataset.name : 'Add supplier';
  if (row) {
    form.elements.name.value = row.dataset.name || '';
    form.elements.contactPerson.value = row.dataset.contact || '';
    form.elements.phone.value = row.dataset.phone || '';
    form.elements.email.value = row.dataset.email || '';
    form.elements.address.value = row.dataset.address || '';
  }
  openModal('supplierModal');
}

function openArchive(btn) {
  const row = rowOf(btn);
  const form = document.getElementById('archiveForm');
  form.reset();
  form.action = '/products/' + row.dataset.id + '/delete';
  document.getElementById('archiveTitle').textContent = 'Archive ' + row.dataset.name + '?';
  openModal('archiveModal');
}

function openVoid(btn) {
  const form = document.getElementById('voidForm');
  form.reset();
  form.action = '/logs/' + btn.dataset.id + '/void';
  document.getElementById('voidDesc').textContent = btn.dataset.desc;
  openModal('voidModal');
}

function filterInventory() {
  const q = document.getElementById('search').value.toLowerCase();
  const c = document.getElementById('categoryFilter').value.toLowerCase();
  document.querySelectorAll('#productRows tr[data-name]').forEach(row => {
    const matchName = row.dataset.name.toLowerCase().includes(q);
    const matchCat = !c || row.dataset.category.toLowerCase() === c;
    row.style.display = matchName && matchCat ? '' : 'none';
  });
}

function filterLots() {
  const q = document.getElementById('lotSearch').value.toLowerCase();
  document.querySelectorAll('#lotRows tr[data-search]').forEach(row => {
    row.style.display = row.dataset.search.toLowerCase().includes(q) ? '' : 'none';
  });
}

