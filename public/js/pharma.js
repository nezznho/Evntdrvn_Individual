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

function openStockIn(btn) {
  const row = rowOf(btn);
  const form = document.getElementById('stockForm');
  form.reset();
  form.action = '/products/' + row.dataset.id + '/stock';
  document.getElementById('stockTitle').textContent = 'Receive stock: ' + row.dataset.name;
  form.elements.expiryDate.min = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  openModal('stockModal');
}

function openDispense(btn) {
  const row = rowOf(btn);
  const lots = JSON.parse(row.dataset.lots || '[]');
  const form = document.getElementById('dispenseForm');
  form.reset();
  form.action = '/products/' + row.dataset.id + '/dispense';
  document.getElementById('dispenseTitle').textContent = 'Dispense: ' + row.dataset.name;
  document.getElementById('dispenseAvail').textContent = lots.length
    ? row.dataset.sellable + ' unexpired unit(s) available across ' + lots.length + ' lot(s).'
    : 'No unexpired stock available to dispense.';
  const select = document.getElementById('dispenseLot');
  select.innerHTML = '';
  select.add(new Option('Auto (FEFO: earliest expiry first)', ''));
  lots.forEach(l => select.add(new Option(l.lot + ' · ' + l.qty + ' units · exp ' + l.exp, l.id)));
  form.elements.quantity.max = row.dataset.sellable;
  openModal('dispenseModal');
}

function setProductFormMode(form, editing) {
  form.querySelector('.opening-stock').style.display = editing ? 'none' : '';
  form.querySelector('.edit-only').style.display = editing ? '' : 'none';
}

function openAddProduct() {
  const form = document.querySelector('#productModal form');
  form.reset();
  form.action = '/products';
  form.querySelector('h2').textContent = 'Add product';
  setProductFormMode(form, false);
  openModal('productModal');
}

function openProductEdit(btn) {
  const row = rowOf(btn);
  const form = document.querySelector('#productModal form');
  form.reset();
  form.action = '/products/' + row.dataset.id + '/edit';
  form.querySelector('h2').textContent = 'Edit product details';
  form.elements.name.value = row.dataset.name;
  form.elements.category.value = row.dataset.category;
  form.elements.price.value = row.dataset.price;
  form.elements.barcode.value = row.dataset.barcode || '';
  setProductFormMode(form, true);
  openModal('productModal');
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
