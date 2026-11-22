// Single place where inventory quantities change. Every function:
//   1. runs inside a DB transaction with row locks (no half-written movements, no race conditions)
//   2. updates the batch (lot) quantity
//   3. recalculates the product's cached total / nearest expiry
//   4. appends an immutable StockLog entry with the user responsible
import { Op } from "sequelize";
import { sequelize } from "../models/db.js";
import { Product } from "../models/productModel.js";
import { Batch } from "../models/batchModel.js";
import { StockLog, VOIDABLE } from "../models/stockLogModel.js";
import { UNITS, fmtQty } from "../helpers/format.js";
import { requireCategory, supplierForDelivery } from "./catalogService.js";

const cleanPrice = value => {
  const price = Number(value);
  if (!Number.isFinite(price) || price < 0 || price > 1_000_000) throw new StockError("Enter a valid price per piece (0 or more).");
  return Math.round(price * 100) / 100;
};

export class StockError extends Error {}

const todayStr = () => new Date().toLocaleDateString("en-CA"); // YYYY-MM-DD in local time
const makeRef = prefix => `${prefix}-${Date.now().toString(36).toUpperCase()}${Math.random().toString(36).slice(2, 5).toUpperCase()}`;
const positiveInt = (value, field = "Quantity") => {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new StockError(`${field} must be a whole number greater than 0.`);
  return n;
};
const requireReason = (reason, min = 5) => {
  const text = String(reason || "").trim();
  if (text.length < min) throw new StockError(`A reason of at least ${min} characters is required.`);
  return text.slice(0, 255);
};

// Quantity typed in a form or sent by the POS, in pieces or boxes -> pieces (the unit stock is kept in).
// Returns the pieces plus how it was entered, so the log can show "10 boxes" next to "+1,000".
function toPieces(product, data) {
  const qty = positiveInt(data.quantity);
  if (String(data.unit || "piece") !== "box") return { pieces: qty, entry: {} };
  const per = Number(product.piecesPerBox);
  if (!Number.isInteger(per) || per < 1) {
    throw new StockError(`${product.name} has no box size. Edit the product and set "pieces per box" first.`);
  }
  const pieces = qty * per;
  if (!Number.isSafeInteger(pieces) || pieces > 10_000_000) throw new StockError("Quantity is too large.");
  return { pieces, entry: { entryUnit: "box", entryQty: qty } };
}

function cleanPackaging(data, current = {}) {
  const unit = data.unit === undefined ? (current.unit || "piece") : String(data.unit).trim().toLowerCase();
  if (!UNITS.includes(unit)) throw new StockError(`Unit must be one of: ${UNITS.join(", ")}.`);
  let piecesPerBox = current.piecesPerBox ?? null;
  if (data.piecesPerBox !== undefined) {
    const raw = String(data.piecesPerBox ?? "").trim();
    piecesPerBox = raw === "" ? null : Number(raw);
    if (piecesPerBox !== null && (!Number.isInteger(piecesPerBox) || piecesPerBox < 1 || piecesPerBox > 100000)) {
      throw new StockError("Pieces per box must be a whole number from 1 to 100,000 (leave blank if not sold by box).");
    }
  }
  let reorderLevel = current.reorderLevel ?? 25;
  if (data.reorderLevel !== undefined && String(data.reorderLevel).trim() !== "") {
    reorderLevel = Number(data.reorderLevel);
    if (!Number.isInteger(reorderLevel) || reorderLevel < 0 || reorderLevel > 10_000_000) {
      throw new StockError("Low-stock alert level must be a whole number of pieces (0 or more).");
    }
  }
  return { unit, piecesPerBox, reorderLevel };
}

// Why stock leaves the shelf without a sale (sales come from the POS as DISPENSED).
export const STOCK_OUT_REASONS = {
  damaged: "Damaged / broken",
  internal_use: "Internal use",
  transfer: "Transfer to another branch",
  return_to_supplier: "Returned to supplier",
  sample: "Free sample / donation",
  other: "Other"
};

async function lockProduct(productId, t, { includeArchived = false } = {}) {
  const product = await Product.findByPk(productId, { transaction: t, lock: t.LOCK.UPDATE, paranoid: !includeArchived });
  if (!product) throw new StockError("Product not found (it may be archived).");
  return product;
}

// Product.quantity = sum of active batches; Product.expiry = nearest expiry with stock on hand.
async function refreshProductTotals(product, t) {
  const batches = await Batch.findAll({ where: { productId: product.id, status: "active" }, transaction: t });
  const withStock = batches.filter(b => b.quantity > 0);
  const quantity = withStock.reduce((sum, b) => sum + b.quantity, 0);
  const expiry = withStock.map(b => b.expiryDate).sort()[0] || null;
  await product.update({ quantity, expiry }, { transaction: t });
  return quantity;
}

function writeLog(t, { action, product, batch = null, amount = 0, user, reason = null, reference = null, voidOfId = null, entry = {}, supplier = null }) {
  return StockLog.create({
    action, productId: product.id, product: product.name,
    batchId: batch?.id ?? null, batchNumber: batch?.batchNumber ?? null,
    amount, balanceAfter: product.quantity, userId: user.id, user: user.name,
    reason, reference, voidOfId, entryUnit: entry.entryUnit ?? null, entryQty: entry.entryQty ?? null,
    supplierId: supplier?.id ?? null, supplier: supplier?.name ?? null
  }, { transaction: t });
}

// Barcodes are unique across ALL products, archived ones included, so a scan is never ambiguous.
async function cleanBarcode(raw, t, exceptId = null) {
  const barcode = String(raw ?? "").trim().slice(0, 64) || null;
  if (!barcode) return null;
  const owner = await Product.findOne({ where: { barcode }, paranoid: false, transaction: t });
  if (owner && owner.id !== Number(exceptId)) {
    throw new StockError(`Barcode ${barcode} is already assigned to ${owner.name}${owner.deletedAt ? " (archived)" : ""}.`);
  }
  return barcode;
}

// Every product needs a code: the POS and Kiosk find products by it (Inventory barcode = POS medicine code).
// A product saved without a barcode gets "INV-00013" (from its id); a clash with a typed code adds a suffix.
async function autoBarcode(product, t) {
  const base = `INV-${String(product.id).padStart(5, "0")}`;
  for (let n = 0; n < 50; n++) {
    const code = n ? `${base}-${n}` : base;
    if (!(await Product.findOne({ where: { barcode: code }, paranoid: false, transaction: t }))) return code;
  }
  throw new StockError("Could not generate a product code. Type a barcode instead.");
}

/** Gives every product without a barcode an automatic code (run by migrate.js). Returns how many were set. */
export async function ensureBarcodes(user) {
  const missing = await Product.findAll({ where: { barcode: null }, paranoid: false, attributes: ["id"], raw: true });
  for (const { id } of missing) {
    await sequelize.transaction(async t => {
      const product = await lockProduct(id, t, { includeArchived: true });
      if (product.barcode) return;
      const code = await autoBarcode(product, t);
      await product.update({ barcode: code }, { transaction: t });
      await writeLog(t, { action: "PRODUCT_UPDATED", product, user, reason: `Product code ${code} assigned automatically (for the POS)` });
    });
  }
  return missing.length;
}

/** Sets a product's code (barcode), e.g. to match a code the POS already uses. Logged like any edit. */
export const assignBarcode = (productId, rawCode, user) => sequelize.transaction(async t => {
  const product = await lockProduct(productId, t, { includeArchived: true });
  const code = await cleanBarcode(rawCode, t, product.id);
  if (!code) throw new StockError("A product code is required.");
  if (code === product.barcode) return product;
  const old = product.barcode;
  await product.update({ barcode: code }, { transaction: t });
  await writeLog(t, { action: "PRODUCT_UPDATED", product, user, reason: `Product code ${old ? `changed from ${old} to` : "set to"} ${code}` });
  return product;
});

// ---------- Product lifecycle ----------

export const createProduct = (data, user) => sequelize.transaction(async t => {
  const name = String(data.name || "").trim();
  if (!name) throw new StockError("Product name is required.");
  const barcode = await cleanBarcode(data.barcode, t);
  const packaging = cleanPackaging(data);
  const category = await requireCategory(data.category);
  const price = cleanPrice(data.price);
  const product = await Product.create({ name, category, price, quantity: 0, barcode, ...packaging }, { transaction: t });
  if (!barcode) await product.update({ barcode: await autoBarcode(product, t) }, { transaction: t });
  await writeLog(t, { action: "PRODUCT_ADDED", product, user, reason: `Product code ${product.barcode}` });
  // Opening stock is optional, but when given it must come with a lot number and expiry like any delivery.
  // data.unit is the product's base unit here; the opening quantity's unit (piece/box) comes as openingUnit.
  if (Number(data.quantity) > 0) product.openingBatch = await receiveInto(t, product, { ...data, unit: data.openingUnit || "piece" }, user);
  return product;
});

export const updateProductDetails = (productId, data, user) => sequelize.transaction(async t => {
  const product = await lockProduct(productId, t);
  // Quantity and expiry are intentionally NOT editable here - they only change through logged movements.
  // A blank barcode keeps the current code: the POS needs every product to keep one.
  const barcode = String(data.barcode ?? "").trim() === "" ? product.barcode : await cleanBarcode(data.barcode, t, product.id);
  const name = String(data.name || "").trim();
  if (!name) throw new StockError("Product name is required.");
  // Changing the box size is safe: stock is stored in pieces, so no quantity changes.
  const packaging = cleanPackaging(data, product);
  // Keep a category that was valid when the product was saved, even if it has since been renamed away.
  const category = data.category === product.category ? product.category : await requireCategory(data.category);
  const price = cleanPrice(data.price);
  await product.update({ name, category, price, barcode, ...packaging }, { transaction: t });
  await writeLog(t, { action: "PRODUCT_UPDATED", product, user, reason: `Details edited (price ₱${price.toFixed(2)}, low-stock alert at ${packaging.reorderLevel})` });
});

export const archiveProduct = (productId, reason, user) => sequelize.transaction(async t => {
  const product = await lockProduct(productId, t);
  const why = requireReason(reason);
  await product.update({ deletedById: user.id, deleteReason: why }, { transaction: t });
  await product.destroy({ transaction: t }); // paranoid => UPDATE Products SET deletedAt = NOW()
  await writeLog(t, { action: "PRODUCT_ARCHIVED", product, user, reason: why });
  return product;
});

export const restoreProduct = (productId, user) => sequelize.transaction(async t => {
  const product = await lockProduct(productId, t, { includeArchived: true });
  if (!product.deletedAt) throw new StockError("Product is not archived.");
  await product.restore({ transaction: t });
  await product.update({ deletedById: null, deleteReason: null }, { transaction: t });
  await writeLog(t, { action: "PRODUCT_RESTORED", product, user });
  return product;
});

// ---------- Stock In (deliveries) ----------

async function receiveInto(t, product, data, user) {
  const { pieces: quantity, entry } = toPieces(product, data);
  const before = product.quantity;
  const batchNumber = String(data.batchNumber || "").trim().toUpperCase();
  const expiryDate = String(data.expiryDate || data.expiry || "");
  if (!batchNumber) throw new StockError("Batch/Lot number is required when receiving stock.");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(expiryDate)) throw new StockError("A valid expiry date is required.");
  if (expiryDate <= todayStr()) throw new StockError("Cannot receive stock that is already expired.");
  const supplier = await supplierForDelivery(data.supplierId);

  let batch = await Batch.findOne({ where: { productId: product.id, batchNumber }, transaction: t, lock: t.LOCK.UPDATE });
  if (batch) {
    if (batch.status !== "active") throw new StockError(`Lot ${batchNumber} is ${batch.status} and cannot receive stock.`);
    if (batch.expiryDate !== expiryDate) throw new StockError(`Lot ${batchNumber} is already on file with expiry ${batch.expiryDate}. One lot has one expiry date - check the label.`);
    await batch.increment("quantity", { by: quantity, transaction: t });
    await batch.reload({ transaction: t });
  } else {
    batch = await Batch.create({ productId: product.id, batchNumber, expiryDate, quantity, manufacturer: String(data.manufacturer || "").trim() || null }, { transaction: t });
  }
  await refreshProductTotals(product, t);
  const reference = String(data.reference || "").trim().slice(0, 40) || makeRef("RCV");
  await writeLog(t, { action: "STOCK_IN", product, batch, amount: quantity, user, reference, reason: String(data.notes || "").trim().slice(0, 255) || null, entry, supplier });
  batch.received = { pieces: quantity, before, after: product.quantity, entry, unit: product.unit, supplier: supplier?.name || null, reference };
  return batch;
}

export const stockIn = (productId, data, user) => sequelize.transaction(async t => {
  const product = await lockProduct(productId, t);
  return receiveInto(t, product, data, user);
});

// ---------- Dispensing (FEFO: First-Expiry, First-Out) ----------

export const dispense = (productId, data, user) =>
  sequelize.transaction(async t => (await dispenseIn(t, productId, data, user)).reference);

// Same FEFO dispensing, but inside a transaction the caller owns, so several dispenses can commit or roll back
// together (e.g. one POS sale with many lines - see services/saleService.js). Returns the per-lot breakdown.
export const dispenseInTransaction = (t, productId, data, user) => dispenseIn(t, productId, data, user);

// Stock out: units leave the shelf for a reason other than a sale (damaged, internal use, transfer...).
// Same FEFO lot picking as a sale, logged as STOCK_OUT with the reason, so it never counts as demand/sales.
export const stockOut = (productId, data, user) => sequelize.transaction(async t => {
  const label = STOCK_OUT_REASONS[data.reasonCode];
  if (!label) throw new StockError("Choose why the stock is going out.");
  const notes = String(data.notes || "").trim();
  if (data.reasonCode === "other" && notes.length < 5) throw new StockError("Describe the reason (at least 5 characters) when choosing Other.");
  const reason = (notes ? `${label}: ${notes}` : label).slice(0, 255);
  return dispenseIn(t, productId, data, user, { action: "STOCK_OUT", prefix: "OUT", reason });
});

async function dispenseIn(t, productId, data, user, { action = "DISPENSED", prefix = "DSP", reason = null } = {}) {
  const product = await lockProduct(productId, t);
  const { pieces: quantity, entry } = toPieces(product, data);
  const where = { productId: product.id, status: "active", quantity: { [Op.gt]: 0 }, expiryDate: { [Op.gt]: todayStr() } };
  if (data.batchId) where.id = Number(data.batchId);
  const batches = await Batch.findAll({ where, order: [["expiryDate", "ASC"], ["id", "ASC"]], transaction: t, lock: t.LOCK.UPDATE });
  const available = batches.reduce((sum, b) => sum + b.quantity, 0);
  if (quantity > available) throw new StockError(`Only ${fmtQty(available, product.unit)} of ${product.name} available (unexpired)${data.batchId ? " in that lot" : ""}.`);

  const reference = makeRef(prefix); // one reference for the whole movement, even if it spans several lots
  let remaining = quantity;
  const lines = [];
  for (const batch of batches) {
    if (remaining === 0) break;
    const take = Math.min(batch.quantity, remaining);
    await batch.update({ quantity: batch.quantity - take }, { transaction: t });
    await refreshProductTotals(product, t);
    // How it was entered (e.g. "2 boxes") is kept on the first line of the reference only.
    await writeLog(t, { action, product, batch, amount: -take, user, reference, reason, entry: lines.length ? {} : entry });
    lines.push({ batchId: batch.id, batchNumber: batch.batchNumber, quantity: take });
    remaining -= take;
  }
  return { reference, product, lines };
}

// ---------- Write-offs ----------

async function writeOff(batchId, user, { action, status, reason }) {
  return sequelize.transaction(async t => {
    const found = await Batch.findByPk(batchId, { transaction: t });
    if (!found) throw new StockError("Batch not found.");
    // Lock order is always product -> batch (same as dispense/void) to avoid deadlocks.
    const product = await lockProduct(found.productId, t, { includeArchived: true });
    const batch = await Batch.findByPk(batchId, { transaction: t, lock: t.LOCK.UPDATE });
    if (batch.status !== "active") throw new StockError(`Lot ${batch.batchNumber} is already ${batch.status}.`);
    const removed = batch.quantity;
    await batch.update({ quantity: 0, status }, { transaction: t });
    await refreshProductTotals(product, t);
    await writeLog(t, { action, product, batch, amount: -removed, user, reason, reference: makeRef(action === "EXPIRED" ? "EXP" : "RCL") });
    return batch;
  });
}

export const expireBatch = async (batchId, reason, user) => {
  const batch = await Batch.findByPk(batchId);
  if (!batch) throw new StockError("Batch not found.");
  // Pulling stock before its expiry date is allowed but must be justified.
  const why = batch.expiryDate <= todayStr() ? (String(reason || "").trim() || "Expired stock pulled from shelf") : requireReason(reason);
  return writeOff(batchId, user, { action: "EXPIRED", status: "expired", reason: why });
};

export const recallBatch = (batchId, reason, user) =>
  writeOff(batchId, user, { action: "RECALLED", status: "recalled", reason: requireReason(reason) });

// ---------- VOID ----------
// Voiding never edits or deletes the original row. It appends a VOID row per original line with the
// opposite quantity, linked through voidOfId (unique => a line can only be voided once).
// All lines sharing the same reference (e.g. a sale split across two lots) are voided together.

export const voidTransaction = (logId, reason, user) =>
  sequelize.transaction(t => voidIn(t, logId, reason, user));

// Same VOID inside a transaction the caller owns (e.g. voiding every line of one POS sale together).
export const voidInTransaction = (t, logId, reason, user) => voidIn(t, logId, reason, user);

async function voidIn(t, logId, reason, user) {
  const why = requireReason(reason);
  const target = await StockLog.findByPk(logId, { transaction: t });
  if (!target) throw new StockError("Log entry not found.");
  if (!VOIDABLE.includes(target.action)) throw new StockError(`"${target.action}" entries cannot be voided.`);
  if (!target.batchId) throw new StockError("Legacy entries without a batch cannot be voided.");

  const lines = target.reference
    ? await StockLog.findAll({ where: { reference: target.reference, action: { [Op.in]: VOIDABLE } }, order: [["id", "ASC"]], transaction: t })
    : [target];
  const alreadyVoided = await StockLog.count({ where: { voidOfId: lines.map(l => l.id) }, transaction: t });
  if (alreadyVoided) throw new StockError("This transaction has already been voided.");

  const product = await lockProduct(target.productId, t, { includeArchived: true });
  for (const line of lines) {
    const batch = await Batch.findByPk(line.batchId, { transaction: t, lock: t.LOCK.UPDATE });
    if (!batch) throw new StockError(`Lot ${line.batchNumber} no longer exists.`);
    const reversal = -line.amount;
    if (batch.quantity + reversal < 0) {
      throw new StockError(`Cannot void: only ${batch.quantity} unit(s) of lot ${batch.batchNumber} remain - part of this delivery was already dispensed.`);
    }
    const changes = { quantity: batch.quantity + reversal };
    if (["EXPIRED", "RECALLED"].includes(line.action)) changes.status = "active"; // undo a mistaken write-off
    await batch.update(changes, { transaction: t });
    await refreshProductTotals(product, t);
    await writeLog(t, { action: "VOID", product, batch, amount: reversal, user, reason: why, reference: line.reference, voidOfId: line.id });
  }
  return { reference: target.reference, lines: lines.length };
}
