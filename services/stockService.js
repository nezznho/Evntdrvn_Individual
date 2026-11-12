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

function writeLog(t, { action, product, batch = null, amount = 0, user, reason = null, reference = null, voidOfId = null }) {
  return StockLog.create({
    action, productId: product.id, product: product.name,
    batchId: batch?.id ?? null, batchNumber: batch?.batchNumber ?? null,
    amount, balanceAfter: product.quantity, userId: user.id, user: user.name,
    reason, reference, voidOfId
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

// ---------- Product lifecycle ----------

export const createProduct = (data, user) => sequelize.transaction(async t => {
  const name = String(data.name || "").trim();
  if (!name) throw new StockError("Product name is required.");
  const barcode = await cleanBarcode(data.barcode, t);
  const product = await Product.create({ name, category: data.category, price: Number(data.price) || 0, quantity: 0, barcode }, { transaction: t });
  await writeLog(t, { action: "PRODUCT_ADDED", product, user });
  // Opening stock is optional, but when given it must come with a lot number and expiry like any delivery.
  if (Number(data.quantity) > 0) await receiveInto(t, product, data, user);
  return product;
});

export const updateProductDetails = (productId, data, user) => sequelize.transaction(async t => {
  const product = await lockProduct(productId, t);
  // Quantity and expiry are intentionally NOT editable here - they only change through logged movements.
  const barcode = data.barcode === undefined ? product.barcode : await cleanBarcode(data.barcode, t, product.id);
  await product.update({ name: String(data.name).trim(), category: data.category, price: Number(data.price) || 0, barcode }, { transaction: t });
  await writeLog(t, { action: "PRODUCT_UPDATED", product, user, reason: `Details edited (price ₱${Number(data.price).toFixed(2)})` });
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
  const quantity = positiveInt(data.quantity);
  const batchNumber = String(data.batchNumber || "").trim().toUpperCase();
  const expiryDate = String(data.expiryDate || data.expiry || "");
  if (!batchNumber) throw new StockError("Batch/Lot number is required when receiving stock.");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(expiryDate)) throw new StockError("A valid expiry date is required.");
  if (expiryDate <= todayStr()) throw new StockError("Cannot receive stock that is already expired.");

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
  await writeLog(t, { action: "STOCK_IN", product, batch, amount: quantity, user, reference, reason: data.notes || null });
  return batch;
}

export const stockIn = (productId, data, user) => sequelize.transaction(async t => {
  const product = await lockProduct(productId, t);
  return receiveInto(t, product, data, user);
});

// ---------- Dispensing (FEFO: First-Expiry, First-Out) ----------

export const dispense = (productId, data, user) => sequelize.transaction(async t => {
  const product = await lockProduct(productId, t);
  const quantity = positiveInt(data.quantity);
  const where = { productId: product.id, status: "active", quantity: { [Op.gt]: 0 }, expiryDate: { [Op.gt]: todayStr() } };
  if (data.batchId) where.id = Number(data.batchId);
  const batches = await Batch.findAll({ where, order: [["expiryDate", "ASC"], ["id", "ASC"]], transaction: t, lock: t.LOCK.UPDATE });
  const available = batches.reduce((sum, b) => sum + b.quantity, 0);
  if (quantity > available) throw new StockError(`Only ${available} unexpired unit(s) of ${product.name} available${data.batchId ? " in that lot" : ""}.`);

  const reference = makeRef("DSP"); // one reference for the whole sale, even if it spans several lots
  let remaining = quantity;
  for (const batch of batches) {
    if (remaining === 0) break;
    const take = Math.min(batch.quantity, remaining);
    await batch.update({ quantity: batch.quantity - take }, { transaction: t });
    await refreshProductTotals(product, t);
    await writeLog(t, { action: "DISPENSED", product, batch, amount: -take, user, reference });
    remaining -= take;
  }
  return reference;
});

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

export const voidTransaction = (logId, reason, user) => sequelize.transaction(async t => {
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
});
