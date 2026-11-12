import { Op } from "sequelize";
import { Product } from "../models/productModel.js";
import { Batch } from "../models/batchModel.js";
import { StockLog, ACTION_META, VOIDABLE } from "../models/stockLogModel.js";
import { User } from "../models/userModel.js";
import * as stock from "../services/stockService.js";

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
async function decorateLogs(logs) {
  const ids = logs.map(l => l.id);
  const voids = ids.length ? await StockLog.findAll({ where: { voidOfId: ids }, attributes: ["voidOfId", "id"], raw: true }) : [];
  const voidedBy = new Map(voids.map(v => [v.voidOfId, v.id]));
  return logs.map(l => {
    const meta = ACTION_META[l.action] || { label: l.action, badge: "badge-gray" };
    return {
      ...l, ...meta,
      time: fmtTime(l.createdAt),
      isVoid: l.action === "VOID",
      isVoided: voidedBy.has(l.id),
      voidLogId: voidedBy.get(l.id),
      amountText: l.amount > 0 ? `+${l.amount}` : l.amount === 0 ? "—" : String(l.amount),
      balanceText: l.balanceAfter ?? "—",
      qtyClass:l.amount > 0 ? "qty-in" : l.amount < 0 ? "qty-out" : "",
      canVoid: VOIDABLE.includes(l.action) && !!l.batchId && !voidedBy.has(l.id)
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
    p.isLow = p.quantity <= 25;
    const sellable = p.batches
      .filter(b => b.status === "active" && b.quantity > 0 && b.expiryDate > today)
      .sort((a, b) => a.expiryDate.localeCompare(b.expiryDate));
    p.lotCount = p.batches.filter(b => b.status === "active" && b.quantity > 0).length;
    p.dispenseOptions = JSON.stringify(sellable.map(b => ({ id: b.id, lot: b.batchNumber, qty: b.quantity, exp: b.expiryDate })));
    p.sellable = sellable.reduce((s, b) => s + b.quantity, 0);
    for (const b of p.batches) {
      const days = daysUntil(b.expiryDate);
      batchRows.push({
        ...b, productName: p.name, days,
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

  res.render("dashboard", {
    title: "Pharma Dashboard", user, isAdmin, inventory: products, batches: activeBatches, users, logs,
    expiring, low, value: value.toFixed(2), total: products.length, lowCount: low.length,
    expiringCount: expiring.length, lotCount: activeBatches.length,
    voidCount: logs.filter(l => l.isVoid).length, today
  });
};

// Stock card for one lot: details + every movement, oldest first, with running balance.
export const batchDetail = async (req, res) => {
  const batch = await Batch.findByPk(req.params.id, {
    include: [{ model: Product, as: "productRef", paranoid: false }]
  });
  if (!batch) return res.status(404).send("Batch not found");
  const b = batch.get({ plain: true });
  const logs = await decorateLogs(await StockLog.findAll({ where: { batchId: b.id }, order: [["id", "ASC"]], raw: true }));
  let running = 0;
  for (const l of logs) { running += l.amount; l.running = running; }
  const days = daysUntil(b.expiryDate);
  res.render("batch", {
    title: `Lot ${b.batchNumber}`, user: req.user, isAdmin: req.user.role === "admin",
    batch: b, product: b.productRef, logs: logs.reverse(),
    isActive: b.status === "active", isExpired: days <= 0, days, receivedText: fmtTime(b.receivedAt),
    dispensedTotal: -logs.filter(l => l.action === "DISPENSED" && !l.isVoided).reduce((s, l) => s + l.amount, 0)
  });
};

// Admin-only "Archive / Trash": soft-deleted products and deactivated staff, with restore.
export const archivePage = async (req, res) => {
  const people = await User.findAll({ paranoid: false, attributes: ["id", "name"], raw: true });
  const nameOf = id => people.find(p => p.id === id)?.name || "—";
  const products = (await Product.findAll({ paranoid: false, where: { deletedAt: { [Op.ne]: null } }, order: [["deletedAt", "DESC"]], raw: true }))
    .map(p => ({ ...p, archivedAt: fmtTime(p.deletedAt), archivedBy: nameOf(p.deletedById) }));
  const staff = (await User.findAll({ paranoid: false, where: { deletedAt: { [Op.ne]: null } }, attributes: ["id", "name", "email", "role", "deletedAt", "deletedById"], raw: true }))
    .map(u => ({ ...u, archivedAt: fmtTime(u.deletedAt), archivedBy: nameOf(u.deletedById) }));
  res.render("archive", { title: "Archive", user: req.user, isAdmin: true, products, staff, productCount: products.length, staffCount: staff.length });
};

// ---------- Product actions ----------

export const addProduct = action(async req => {
  const p = await stock.createProduct(req.body, req.user);
  return `${p.name} added${Number(req.body.quantity) > 0 ? ` with ${req.body.quantity} unit(s) in lot ${String(req.body.batchNumber).toUpperCase()}` : ""}.`;
});

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
  return { message: `${p.name} restored to active inventory.`, redirect: "/admin/archive" };
}, "/admin/archive");

// ---------- Stock movements ----------

export const updateStock = action(async req => {
  const batch = await stock.stockIn(req.params.id, req.body, req.user);
  return `Received ${req.body.quantity} unit(s) into lot ${batch.batchNumber}.`;
});

export const dispense = action(async req => {
  const ref = await stock.dispense(req.params.id, req.body, req.user);
  return `Dispensed ${req.body.quantity} unit(s). Reference ${ref}.`;
});

export const expireBatch = action(async req => {
  const b = await stock.expireBatch(req.params.id, req.body.reason, req.user);
  return { message: `Lot ${b.batchNumber} written off as expired.`, redirect: `/batches/${b.id}` };
}, "/dashboard#batches");

export const recallBatch = action(async req => {
  const b = await stock.recallBatch(req.params.id, req.body.reason, req.user);
  return { message: `Lot ${b.batchNumber} recalled and quarantined.`, redirect: `/batches/${b.id}` };
}, "/dashboard#batches");

export const voidLog = action(async req => {
  const r = await stock.voidTransaction(req.params.id, req.body.reason, req.user);
  return `Voided ${r.lines} line(s)${r.reference ? ` of ${r.reference}` : ""}. Stock has been reversed.`;
}, "/dashboard#logs");

// ---------- Staff (soft delete = deactivate) ----------

export const addUser = action(async req => {
  const { name, email, password, role } = req.body;
  const existing = await User.findOne({ where: { email }, paranoid: false });
  if (existing) throw new stock.StockError(existing.deletedAt ? "That email belongs to a deactivated account - restore it from the Archive page." : "That email is already registered.");
  await User.create({ name, email, password: password || "staff123", role });
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
}, "/admin/archive");

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
