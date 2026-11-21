// Records a sale. Every line reduces stock through stockService (FEFO, row locks, immutable DISPENSED log),
// and the whole sale commits or rolls back as one transaction. The POS reaches this through routes/posApi.js.
import { Op, UniqueConstraintError } from "sequelize";
import { sequelize } from "../models/db.js";
import { Sale } from "../models/saleModel.js";
import { SaleItem } from "../models/saleItemModel.js";
import { StockLog } from "../models/stockLogModel.js";
import * as stock from "./stockService.js";

const makeRef = () => `SALE-${Date.now().toString(36).toUpperCase()}${Math.random().toString(36).slice(2, 5).toUpperCase()}`;
const money = v => (v === null || v === undefined || v === "" ? null : Math.round(Number(v) * 100) / 100);

/**
 * @param {Array<{productId:number, qty:number, unit?:"piece"|"box", batchId?:number, unitPrice?:number, unitCost?:number}>} items
 *   qty/unitPrice are per `unit` (default piece); boxes are converted to pieces with the product's piecesPerBox.
 * @param {{id:number, name:string}} user
 * @param {{createdAt?: Date, source?: string, externalRef?: string, cashier?: string}} [options]
 *   createdAt is for seeding sample history only; source/externalRef/cashier link the sale to a POS receipt.
 */
export const recordSale = (items, user, { createdAt, source = null, externalRef = null, cashier = null } = {}) => sequelize.transaction(async t => {
  if (!Array.isArray(items) || !items.length) throw new stock.StockError("A sale needs at least one item.");
  const sale = await Sale.create({
    reference: makeRef(), user_id: user.id, total: 0, source, external_ref: externalRef, cashier,
    ...(createdAt && { createdAt })
  }, { transaction: t });
  let total = 0;
  for (const item of items) {
    const { reference, product, lines } = await stock.dispenseInTransaction(t, item.productId, { quantity: item.qty, unit: item.unit, batchId: item.batchId }, user);
    const perBox = item.unit === "box" ? Number(product.piecesPerBox) : 1; // prices are stored per piece
    const unitPrice = money(item.unitPrice === undefined || item.unitPrice === null ? null : item.unitPrice / perBox) ?? Number(product.price);
    const unitCost = money(item.unitCost === undefined || item.unitCost === null ? null : item.unitCost / perBox);
    for (const line of lines) {
      await SaleItem.create({
        sale_id: sale.id, product_id: product.id, lot_id: line.batchId, qty: line.quantity,
        unit_price: unitPrice, unit_cost: unitCost, user_id: user.id, stock_ref: reference,
        ...(createdAt && { createdAt })
      }, { transaction: t });
      total += line.quantity * unitPrice;
    }
  }
  await sale.update({ total: Math.round(total * 100) / 100 }, { transaction: t });
  return sale;
});

// ---------- POS integration (routes/posApi.js) ----------

export const findPosSale = (externalRef, transaction) =>
  Sale.findOne({ where: { external_ref: externalRef }, include: [{ model: SaleItem, as: "items" }], transaction });

// Idempotent: the POS may retry after a timeout, so one POS receipt number never deducts stock twice.
export async function recordPosSale(items, user, { externalRef, cashier }) {
  const existing = await findPosSale(externalRef);
  if (existing) return { sale: existing, duplicate: true };
  try {
    await recordSale(items, user, { source: "pos", externalRef, cashier });
    return { sale: await findPosSale(externalRef), duplicate: false };
  } catch (err) {
    // Two copies of the same request raced; the unique index on external_ref let only one through.
    if (err instanceof UniqueConstraintError) {
      const sale = await findPosSale(externalRef);
      if (sale) return { sale, duplicate: true };
    }
    throw err;
  }
}

// True when any of the sale's DISPENSED movements has been reversed by a VOID (the POS treats the sale as cancelled).
export async function isPosSaleVoided(sale) {
  const refs = [...new Set((sale.items || []).map(i => i.stock_ref).filter(Boolean))];
  if (!refs.length) return false;
  const lines = await StockLog.findAll({ where: { reference: { [Op.in]: refs }, action: "DISPENSED" }, attributes: ["id"] });
  return lines.length > 0 && (await StockLog.count({ where: { voidOfId: { [Op.in]: lines.map(l => l.id) } } })) > 0;
}

// Voids every stock movement of one POS sale in a single transaction, so the units go back to their exact lots.
// A sale that is already voided returns { alreadyVoided: true } instead of failing, so POS retries are safe.
export const voidPosSale = (externalRef, reason, user) => sequelize.transaction(async t => {
  const sale = await Sale.findOne({ where: { external_ref: externalRef }, transaction: t, lock: t.LOCK.UPDATE });
  if (!sale) throw new stock.StockError(`No synced sale with POS reference ${externalRef}.`);
  const items = await SaleItem.findAll({ where: { sale_id: sale.id }, transaction: t });
  const refs = [...new Set(items.map(i => i.stock_ref).filter(Boolean))];
  const dispensed = refs.length
    ? await StockLog.findAll({ where: { reference: { [Op.in]: refs }, action: "DISPENSED" }, order: [["id", "ASC"]], transaction: t })
    : [];
  const voided = new Set((dispensed.length
    ? await StockLog.findAll({ where: { voidOfId: { [Op.in]: dispensed.map(l => l.id) } }, attributes: ["voidOfId"], transaction: t })
    : []).map(v => v.voidOfId));

  let linesReversed = 0;
  for (const ref of refs) {
    const lines = dispensed.filter(l => l.reference === ref);
    if (!lines.length || lines.some(l => voided.has(l.id))) continue; // this line was already reversed
    linesReversed += (await stock.voidInTransaction(t, lines[0].id, reason, user)).lines;
  }
  return { sale, alreadyVoided: linesReversed === 0, linesReversed };
});
