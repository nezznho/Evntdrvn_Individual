import { Op } from "sequelize";
import { Product } from "../models/productModel.js";
import { Batch } from "../models/batchModel.js";
import { StockLog, ACTION_META, VOIDABLE } from "../models/stockLogModel.js";
import { User } from "../models/userModel.js";
import { Sale } from "../models/saleModel.js";
import { SaleItem } from "../models/saleItemModel.js";

// Stock references (DSP-...) that belong to a sale pushed by the POS. Those are voided from the POS (F2),
// which keeps both systems in agreement; voiding them here would leave the sale "completed" on the POS.
async function posStockRefs(refs) {
  const list = [...new Set(refs.filter(Boolean))];
  if (!list.length) return new Set();
  const rows = await SaleItem.findAll({
    where: { stock_ref: list }, attributes: ["stock_ref"],
    include: [{ model: Sale, as: "sale", attributes: [], where: { source: "pos" }, required: true }], raw: true
  });
  return new Set(rows.map(r => r.stock_ref));
}
import * as stock from "../services/stockService.js";
import { dashboardStats, AnalyticsError } from "../services/analyticsService.js";
import { fmtMoney, fmtQty, fmtInt, boxBreakdown, unitLabel, UNITS } from "../helpers/format.js";

import * as catalog from "../services/catalogService.js";
import { Supplier } from "../models/supplierModel.js";

// Categories come from the Categories page (services/catalogService.js).
const categoryList = () => catalog.categoryNames();
const stockOutReasons = () => Object.entries(stock.STOCK_OUT_REASONS).map(([value, label]) => ({ value, label }));
const activeSuppliers = () => Supplier.findAll({ attributes: ["id", "name"], order: [["name", "ASC"]], raw: true });
const unitOptions = selected => UNITS.map(u => ({ value: u, label: u === "piece" ? "Piece (pcs)" : u[0].toUpperCase() + u.slice(1), selected: u === selected }));

// Auth is handled by requireAuth / requireAdmin in routes/index.js; req.user is the signed-in user.

const todayStr = () => new Date().toLocaleDateString("en-CA");
const daysUntil = date => Math.round((new Date(`${date}T00:00:00`) - new Date(`${todayStr()}T00:00:00`)) / 86400000);
const fmtTime = d => new Date(d).toLocaleString("en-PH", { dateStyle: "medium", timeStyle: "short" });

// Wraps a POST action: success -> flash message, known error -> flash error, then redirect (PRG pattern).
const action = (fn, redirectTo = "/dashboard#inventory") => async (req, res) => {
  let target = redirectTo;
  try {
    const result = await fn(req, res);
    if (typeof result === "string") req.flash("success_msg", result);
    else if (result?.message) { req.flash("success_msg", result.message); target = result.redirect || target; }
  } catch (err) {
    const known = err instanceof stock.StockError || err.name?.startsWith("Sequelize") && err.name !== "SequelizeDatabaseError";
    if (!known) console.error(err);
    req.flash("error_msg", known ? (err.errors?.[0]?.message || err.message) : "Something went wrong. The action was not saved.");
  }
  res.redirect(target);
};

// Adds display fields to log rows and marks entries that have been voided.
async function decorateLogs(logs, { voidable = false } = {}) {
  const ids = logs.map(l => l.id);
  const productIds = [...new Set(logs.map(l => l.productId).filter(Boolean))];
  const packaging = new Map((productIds.length
    ? await Product.findAll({ where: { id: productIds }, attributes: ["id", "unit", "piecesPerBox"], paranoid: false, raw: true })
    : []).map(p => [p.id, p]));
  const voids = ids.length ? await StockLog.findAll({ where: { voidOfId: ids }, attributes: ["voidOfId", "id"], raw: true }) : [];
  const voidedBy = new Map(voids.map(v => [v.voidOfId, v.id]));
  const fromPos = voidable ? await posStockRefs(logs.filter(l => l.action === "DISPENSED").map(l => l.reference)) : new Set();
  return logs.map(l => {
    const meta = ACTION_META[l.action] || { label: l.action, badge: "badge-gray" };
    const pk = packaging.get(l.productId) || {};
    const moves = l.amount !== 0 && l.balanceAfter !== null && l.balanceAfter !== undefined;
    const before = moves ? l.balanceAfter - l.amount : null;
    return {
      ...l, ...meta,
      unitText: unitLabel(pk.unit, l.amount),
      // Stock growth: product total before and after this movement, e.g. 10 -> 1,010 (+10,000%)
      beforeText: moves ? fmtInt(before) : null,
      afterText: l.balanceAfter === null || l.balanceAfter === undefined ? "—" : fmtInt(l.balanceAfter),
      growthText: moves && l.amount > 0 ? (before > 0 ? `+${fmtInt(Math.round((l.amount / before) * 1000) / 10)}%` : "new stock") : null,
      supplierText: l.supplier || null,
      entryText: l.entryUnit === "box" && l.entryQty ? `${fmtInt(l.entryQty)} box${l.entryQty === 1 ? "" : "es"}` : null,
      boxText: !l.entryUnit ? boxBreakdown(l.amount, pk.piecesPerBox) : "",
      time: fmtTime(l.createdAt),
      isVoid: l.action === "VOID",
      isVoided: voidedBy.has(l.id),
      voidLogId: voidedBy.get(l.id),
      amountText: l.amount > 0 ? `+${fmtInt(l.amount)}` : l.amount === 0 ? "—" : `−${fmtInt(-l.amount)}`,
      qtyClass: l.amount > 0 ? "qty-in" : l.amount < 0 ? "qty-out" : "",
      // Voiding is done from the lot's stock card only; the Stock logs page is read-only.
      fromPos: fromPos.has(l.reference),
      canVoid: voidable && VOIDABLE.includes(l.action) && !!l.batchId && !voidedBy.has(l.id) && !fromPos.has(l.reference)
    };
  });
}

// ---------- Pages ----------

export const dashboard = async (req, res) => {
  const user = req.user;
  const isAdmin = user.role === "admin";
  const today = todayStr();

  // Archived products are excluded automatically (paranoid model => WHERE deletedAt IS NULL).
  const products = (await Product.findAll({
    order: [["name", "ASC"]],
    include: [{ model: Batch, as: "batches", required: false }]
  })).map(p => p.get({ plain: true }));

  const batchRows = [];
  for (const p of products) {
    p.price = Number(p.price);
    p.priceText = fmtMoney(p.price);
    p.isLow = p.quantity <= p.reorderLevel; // per-product low-stock alert level (pieces)
    p.reorderText = fmtQty(p.reorderLevel, p.unit);
    p.unitText = unitLabel(p.unit, p.quantity);
    p.qtyText = fmtInt(p.quantity);
    p.boxText = boxBreakdown(p.quantity, p.piecesPerBox);
    p.packText = p.piecesPerBox ? `1 box = ${fmtQty(p.piecesPerBox, p.unit)}` : "";
    p.boxPriceText = p.piecesPerBox ? fmtMoney(p.price * p.piecesPerBox) : "";
    const sellable = p.batches
      .filter(b => b.status === "active" && b.quantity > 0 && b.expiryDate > today)
      .sort((a, b) => a.expiryDate.localeCompare(b.expiryDate));
    p.lotCount = p.batches.filter(b => b.status === "active" && b.quantity > 0).length;
    p.dispenseOptions = JSON.stringify(sellable.map(b => ({ id: b.id, lot: b.batchNumber, qty: b.quantity, exp: b.expiryDate })));
    p.sellable = sellable.reduce((s, b) => s + b.quantity, 0);
    for (const b of p.batches) {
      const days = daysUntil(b.expiryDate);
      batchRows.push({
        ...b, productName: p.name, days, qtyText: fmtQty(b.quantity, p.unit), boxText: boxBreakdown(b.quantity, p.piecesPerBox),
        isExpired: b.status === "active" && days <= 0,
        isExpiringSoon: b.status === "active" && days > 0 && days <= 45
      });
    }
    delete p.batches;
  }
  batchRows.sort((a, b) => a.expiryDate.localeCompare(b.expiryDate));
  const activeBatches = batchRows.filter(b => b.quantity > 0 && b.status === "active");

  const logs = isAdmin
    ? await decorateLogs(await StockLog.findAll({ order: [["createdAt", "DESC"], ["id", "DESC"]], limit: 40, raw: true }))
    : [];
  const users = isAdmin
    ? (await User.findAll({ attributes: ["id", "name", "email", "role"], order: [["name", "ASC"]], raw: true }))
        .map(u => ({ ...u, isSelf: u.id === user.id }))
    : [];

  const low = products.filter(p => p.isLow);
  const expiring = activeBatches.filter(b => b.isExpired || b.isExpiringSoon);
  const value = products.reduce((sum, p) => sum + p.quantity * p.price, 0);
  const archive = isAdmin ? await loadArchive() : null;

  res.render("dashboard", {
    title: "Pharma Dashboard", user, isAdmin, inventory: products, batches: activeBatches, users, logs,
    expiring, low, value: fmtMoney(value), archive, total: products.length, lowCount: low.length,
    expiringCount: expiring.length, lotCount: activeBatches.length,
    voidCount: logs.filter(l => l.isVoid).length, today,
    categories: await categoryList(), units: unitOptions("piece"),
    categoryRows: isAdmin ? await catalog.listCategories() : [],
    supplierRows: isAdmin ? (await catalog.listSuppliers()).map(s => ({ ...s, lastDeliveryText: s.lastDelivery ? fmtTime(s.lastDelivery) : null })) : [],
    suppliers: await activeSuppliers(), stockOutReasons: stockOutReasons()
  });
};

// Stock card for one lot: details + every movement, oldest first, with running balance.
export const batchDetail = async (req, res) => {
  const batch = await Batch.findByPk(req.params.id, {
    include: [{ model: Product, as: "productRef", paranoid: false }]
  });
  if (!batch) return res.status(404).send("Batch not found");
  const b = batch.get({ plain: true });
  const isAdmin = req.user.role === "admin";
  const logs = await decorateLogs(await StockLog.findAll({ where: { batchId: b.id }, order: [["id", "ASC"]], raw: true }), { voidable: isAdmin });
  let running = 0;
  for (const l of logs) { running += l.amount; l.running = running; }
  const days = daysUntil(b.expiryDate);
  res.render("batch", {
    title: `Lot ${b.batchNumber}`, user: req.user, isAdmin,
    unitText: unitLabel(b.productRef?.unit, b.quantity), boxText: boxBreakdown(b.quantity, b.productRef?.piecesPerBox),
    batch: b, product: b.productRef, logs: logs.reverse(),
    isActive: b.status === "active", isExpired: days <= 0, days, receivedText: fmtTime(b.receivedAt),
    dispensedTotal: -logs.filter(l => l.action === "DISPENSED" && !l.isVoided).reduce((s, l) => s + l.amount, 0)
  });
};

// Admin-only "Archive / Trash": soft-deleted products and deactivated staff, with restore.
async function loadArchive() {
  const people = await User.findAll({ paranoid: false, attributes: ["id", "name"], raw: true });
  const nameOf = id => people.find(p => p.id === id)?.name || "—";
  const products = (await Product.findAll({ paranoid: false, where: { deletedAt: { [Op.ne]: null } }, order: [["deletedAt", "DESC"]], raw: true }))
    .map(p => ({ ...p, archivedAt: fmtTime(p.deletedAt), archivedBy: nameOf(p.deletedById) }));
  const staff = (await User.findAll({ paranoid: false, where: { deletedAt: { [Op.ne]: null } }, attributes: ["id", "name", "email", "role", "deletedAt", "deletedById"], raw: true }))
    .map(u => ({ ...u, archivedAt: fmtTime(u.deletedAt), archivedBy: nameOf(u.deletedById) }));
  const suppliers = (await Supplier.findAll({ paranoid: false, where: { deletedAt: { [Op.ne]: null } }, order: [["deletedAt", "DESC"]], raw: true }))
    .map(s => ({ ...s, archivedAt: fmtTime(s.deletedAt) }));
  return { products, staff, suppliers, productCount: products.length, staffCount: staff.length, supplierCount: suppliers.length };
}

// Standalone page kept for old bookmarks; the dashboard shows the same tables in its Archive view.
export const archivePage = async (req, res) => {
  res.render("archive", { title: "Archive", user: req.user, isAdmin: true, archive: await loadArchive() });
};

// ---------- Product actions ----------

// Separate page for registering a product (the Edit dialog is only for changing details).
export const newProductPage = async (req, res) => {
  res.render("product-new", {
    title: "Add product", user: req.user, isAdmin: true,
    categories: await categoryList(), units: unitOptions("piece"), suppliers: await activeSuppliers(),
    barcode: String(req.query.barcode || "").slice(0, 64),
    minExpiry: new Date(Date.now() + 86400000).toLocaleDateString("en-CA")
  });
};

const stockInMessage = (name, r) =>
  `${name}: ${fmtInt(r.before)} → ${fmtInt(r.after)} ${unitLabel(r.unit, r.after)} (+${fmtQty(r.pieces, r.unit)}${r.entry.entryUnit === "box" ? ` = ${fmtInt(r.entry.entryQty)} box${r.entry.entryQty === 1 ? "" : "es"}` : ""})${r.supplier ? ` from ${r.supplier}` : ""}, receipt ${r.reference}.`;

export const addProduct = async (req, res) => {
  try {
    const p = await stock.createProduct(req.body, req.user);
    const opening = p.openingBatch?.received;
    req.flash("success_msg", (opening ? `Product added. ${stockInMessage(p.name, opening)}` : `${p.name} added. Use Receive stock to add its first lot.`) + ` Product code: ${p.barcode} (the POS sees it automatically).`);
    res.redirect("/dashboard#inventory");
  } catch (err) {
    const known = err instanceof stock.StockError || err.name?.startsWith("Sequelize") && err.name !== "SequelizeDatabaseError";
    if (!known) console.error(err);
    req.flash("error_msg", known ? (err.errors?.[0]?.message || err.message) : "Something went wrong. The product was not saved.");
    res.redirect("/products/new");
  }
};

export const editProduct = action(async req => {
  await stock.updateProductDetails(req.params.id, req.body, req.user);
  return "Product details updated.";
});

// "Delete" button => soft delete (archive). There is no route that issues DELETE FROM.
export const deleteProduct = action(async req => {
  const p = await stock.archiveProduct(req.params.id, req.body.reason, req.user);
  return `${p.name} archived. An admin can restore it from the Archive page.`;
});

export const restoreProduct = action(async req => {
  const p = await stock.restoreProduct(req.params.id, req.user);
  return { message: `${p.name} restored to active inventory.`, redirect: "/dashboard#archive" };
}, "/dashboard#archive");

// ---------- Stock movements ----------

export const updateStock = action(async req => {
  const batch = await stock.stockIn(req.params.id, req.body, req.user);
  const product = await Product.findByPk(batch.productId, { attributes: ["name"], raw: true });
  return `Lot ${batch.batchNumber} received. ${stockInMessage(product.name, batch.received)}`;
});

// Stock out (damaged, internal use, transfer...). Selling is done on the POS, which reports sales as DISPENSED.
export const stockOut = action(async req => {
  const { reference, product } = await stock.stockOut(req.params.id, req.body, req.user);
  const boxes = req.body.unit === "box";
  const n = Number(req.body.quantity);
  return `Stock out recorded: ${fmtInt(n)} ${boxes ? (n === 1 ? "box" : "boxes") : unitLabel(product.unit, n)} of ${product.name} (${stock.STOCK_OUT_REASONS[req.body.reasonCode]}). Now ${fmtQty(product.quantity, product.unit)} on hand. Reference ${reference}.`;
});

// ---------- Categories & suppliers (admin) ----------

export const createCategory = action(async req => {
  const c = await catalog.createCategory(req.body);
  return { message: `Category "${c.name}" added.`, redirect: "/dashboard#categories" };
}, "/dashboard#categories");

export const renameCategory = action(async req => {
  const { category, old, moved } = await catalog.renameCategory(req.params.id, req.body);
  return { message: old === category.name ? "Category updated." : `"${old}" renamed to "${category.name}" (${moved} product(s) updated).`, redirect: "/dashboard#categories" };
}, "/dashboard#categories");

export const deleteCategory = action(async req => {
  const c = await catalog.deleteCategory(req.params.id);
  return { message: `Category "${c.name}" deleted.`, redirect: "/dashboard#categories" };
}, "/dashboard#categories");

export const createSupplier = action(async req => {
  const s = await catalog.createSupplier(req.body);
  return { message: `Supplier "${s.name}" added.`, redirect: "/dashboard#suppliers" };
}, "/dashboard#suppliers");

export const updateSupplier = action(async req => {
  const s = await catalog.updateSupplier(req.params.id, req.body);
  return { message: `Supplier "${s.name}" updated.`, redirect: "/dashboard#suppliers" };
}, "/dashboard#suppliers");

export const archiveSupplier = action(async req => {
  const s = await catalog.archiveSupplier(req.params.id);
  return { message: `Supplier "${s.name}" archived. Past deliveries keep their supplier; restore it from the Archive page.`, redirect: "/dashboard#suppliers" };
}, "/dashboard#suppliers");

export const restoreSupplier = action(async req => {
  const s = await catalog.restoreSupplier(req.params.id);
  return { message: `Supplier "${s.name}" restored.`, redirect: "/dashboard#archive" };
}, "/dashboard#archive");

export const expireBatch = action(async req => {
  const b = await stock.expireBatch(req.params.id, req.body.reason, req.user);
  return { message: `Lot ${b.batchNumber} written off as expired.`, redirect: `/batches/${b.id}` };
}, "/dashboard#batches");

export const recallBatch = action(async req => {
  const b = await stock.recallBatch(req.params.id, req.body.reason, req.user);
  return { message: `Lot ${b.batchNumber} recalled and quarantined.`, redirect: `/batches/${b.id}` };
}, "/dashboard#batches");

export const voidLog = action(async req => {
  const target = await StockLog.findByPk(req.params.id, { attributes: ["reference"], raw: true });
  if (target && (await posStockRefs([target.reference])).size) {
    throw new stock.StockError("This movement is a POS sale. Void it from the POS (F2) so the sale and the stock stay in agreement.");
  }
  const r = await stock.voidTransaction(req.params.id, req.body.reason, req.user);
  const log = await StockLog.findByPk(req.params.id, { attributes: ["batchId"], raw: true });
  return {
    message: `Voided ${r.lines} line(s)${r.reference ? ` of ${r.reference}` : ""}. Stock has been reversed.`,
    redirect: log?.batchId ? `/batches/${log.batchId}` : "/dashboard#lots"
  };
}, "/dashboard#lots");

// ---------- Staff (soft delete = deactivate) ----------

export const addUser = action(async req => {
  const { name, email, password, role } = req.body;
  const existing = await User.findOne({ where: { email }, paranoid: false });
  if (existing) throw new stock.StockError(existing.deletedAt ? "That email belongs to a deactivated account - restore it from the Archive page." : "That email is already registered.");
  if (String(password || "").length < 8) throw new stock.StockError("The temporary password must be at least 8 characters.");
  await User.create({ name, email, password, role }); // hashed by the User model
  return `${name} added.`;
}, "/dashboard#staff");

export const deleteUser = action(async req => {
  const target = await User.findByPk(req.params.id);
  if (!target) throw new stock.StockError("Staff account not found.");
  if (target.id === req.user.id) throw new stock.StockError("You cannot deactivate your own account.");
  await target.update({ deletedById: req.user.id });
  await target.destroy(); // paranoid => UPDATE Users SET deletedAt = NOW()
  return `${target.name} deactivated. Their history is preserved.`;
}, "/dashboard#staff");

export const restoreUser = action(async req => {
  const target = await User.findByPk(req.params.id, { paranoid: false });
  if (!target?.deletedAt) throw new stock.StockError("Account is not deactivated.");
  await target.restore();
  await target.update({ deletedById: null });
  return `${target.name} reactivated.`;
}, "/dashboard#archive");

// ---------- JSON API (command palette + barcode scanner, used by public/js/keyboard.js) ----------

const productHref = id => `/dashboard?product=${id}#inventory`;
const likeEscape = text => text.replace(/[\\%_]/g, c => "\\" + c);

// GET /api/search?q=... -> [{ type, id, label, detail, href }]  (active products + lots, max 8 of each)
export const searchApi = async (req, res) => {
  const q = String(req.query.q || "").trim().slice(0, 60);
  if (!q) return res.json([]);
  const like = { [Op.like]: `%${likeEscape(q)}%` };
  const [products, batches] = await Promise.all([
    Product.findAll({ where: { [Op.or]: [{ name: like }, { barcode: q }] }, attributes: ["id", "name", "category", "quantity"], order: [["name", "ASC"]], limit: 8, raw: true }),
    Batch.findAll({ // a lot matches on its own number or on its product's name ("amox" -> AMX24051)
      where: { [Op.or]: [{ batchNumber: like }, { "$productRef.name$": like }] },
      order: [["status", "ASC"], ["expiryDate", "ASC"]], limit: 8,
      include: [{ model: Product, as: "productRef", attributes: ["name"], paranoid: false, required: false }]
    })
  ]);
  res.json([
    ...products.map(p => ({ type: "product", id: p.id, label: p.name, detail: `${p.category} · ${p.quantity} on hand`, href: productHref(p.id) })),
    ...batches.map(b => ({
      type: "lot", id: b.id, label: `${b.batchNumber} · ${b.productRef?.name ?? "Unknown product"}`,
      detail: `${b.status} · ${b.quantity} on hand · exp ${b.expiryDate}`, href: `/batches/${b.id}`
    }))
  ]);
};

// GET /api/products/by-barcode/:code -> { type, id, label, href }  or  404 { error }
export const productByBarcode = async (req, res) => {
  const code = String(req.params.code || "").trim().slice(0, 64);
  const p = code ? await Product.findOne({ where: { barcode: code }, attributes: ["id", "name"], raw: true }) : null;
  if (!p) return res.status(404).json({ error: `No product with barcode ${code}` });
  res.json({ type: "product", id: p.id, label: p.name, href: productHref(p.id) });
};

// GET /api/dashboard/stats?range=daily|monthly|yearly&from=YYYY-MM-DD&to=YYYY-MM-DD  (see services/analyticsService.js)
export const statsApi = async (req, res) => {
  try {
    const stats = await dashboardStats({
      range: String(req.query.range || "daily"),
      from: req.query.from ? String(req.query.from) : undefined,
      to: req.query.to ? String(req.query.to) : undefined
    });
    res.set("Cache-Control", "no-store").json(stats);
  } catch (err) {
    if (err instanceof AnalyticsError) return res.status(400).json({ error: err.message });
    throw err;
  }
};
