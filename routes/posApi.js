// JSON API for the POS (PharmaCore) running on another device. This inventory system owns the stock:
// the POS reads products/stock/prices here and pushes every completed sale and void back.
// All routes need   Authorization: Bearer <POS_API_KEY>   (middleware/posApiAuth.js).
//
//   GET  /api/pos/v1/health                         -> { ok, time }
//   GET  /api/pos/v1/products?q=&codes=&updatedSince= -> [{ id, barcode, name, category, price, unit, piecesPerBox, sellable, onHand, nearestExpiry, updatedAt }]
//        price, sellable and onHand are per piece (the product's base unit); a box = piecesPerBox pieces.
//   GET  /api/pos/v1/products/barcode/:code         -> one product (404 if unknown)
//   GET  /api/pos/v1/products/:id                   -> one product, with its sellable lots
//   POST /api/pos/v1/sales                          -> record a sale (idempotent on `reference`)
//   GET  /api/pos/v1/sales/:reference               -> a synced sale
//   POST /api/pos/v1/sales/:reference/void          -> return a sale's units to their lots (idempotent)
import express from "express";
import { Op, fn, col } from "sequelize";
import { Product } from "../models/productModel.js";
import { Batch } from "../models/batchModel.js";
import { requirePosKey } from "../middleware/posApiAuth.js";
import { StockError } from "../services/stockService.js";
import { recordPosSale, findPosSale, voidPosSale, isPosSaleVoided } from "../services/saleService.js";

const router = express.Router();
const safe = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const todayStr = () => new Date().toLocaleDateString("en-CA");
const REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._\-\/]{2,63}$/; // POS receipt numbers such as PC-20261121-0001
const likeEscape = s => s.replace(/[\\%_]/g, c => `\\${c}`);

router.use(express.json({ limit: "256kb" })); // own parser, so bad JSON gets a JSON error (handler at the bottom)
router.use(requirePosKey);

// Sellable = active lots with stock that have not expired (same rule the FEFO dispense uses).
async function sellableByProduct(productIds) {
  const where = { status: "active", quantity: { [Op.gt]: 0 }, expiryDate: { [Op.gt]: todayStr() } };
  if (productIds) where.productId = { [Op.in]: productIds };
  const rows = await Batch.findAll({
    where, attributes: ["productId", [fn("SUM", col("quantity")), "sellable"], [fn("MIN", col("expiryDate")), "nearestExpiry"]],
    group: ["productId"], raw: true
  });
  return new Map(rows.map(r => [r.productId, { sellable: Number(r.sellable), nearestExpiry: r.nearestExpiry }]));
}

const toDto = (p, stockInfo) => ({
  id: p.id, barcode: p.barcode, name: p.name, category: p.category, price: Number(p.price),
  unit: p.unit, piecesPerBox: p.piecesPerBox, reorderLevel: p.reorderLevel,
  sellable: stockInfo?.sellable ?? 0, onHand: p.quantity, nearestExpiry: stockInfo?.nearestExpiry ?? null,
  updatedAt: p.updatedAt
});

router.get("/health", (req, res) => res.json({ ok: true, system: "PharmaCare inventory", time: new Date().toISOString() }));

router.get("/products", safe(async (req, res) => {
  const where = {};
  const q = String(req.query.q || "").trim().slice(0, 60);
  if (q) where[Op.or] = [{ name: { [Op.like]: `%${likeEscape(q)}%` } }, { barcode: q }];
  // ?codes=A,B,C -> exact barcode matches (the POS medicine code is the inventory barcode)
  const codes = String(req.query.codes || "").split(",").map(c => c.trim().slice(0, 64)).filter(Boolean).slice(0, 500);
  if (codes.length) where.barcode = { [Op.in]: codes };
  if (req.query.updatedSince) {
    const since = new Date(String(req.query.updatedSince));
    if (Number.isNaN(since.getTime())) return res.status(400).json({ error: "updatedSince must be an ISO date/time." });
    where.updatedAt = { [Op.gte]: since };
  }
  const products = await Product.findAll({ where, order: [["name", "ASC"]], limit: 2000, raw: true });
  const stockMap = await sellableByProduct(products.map(p => p.id));
  res.set("Cache-Control", "no-store").json(products.map(p => toDto(p, stockMap.get(p.id))));
}));

router.get("/products/barcode/:code", safe(async (req, res) => {
  const code = String(req.params.code || "").trim().slice(0, 64);
  const p = code ? await Product.findOne({ where: { barcode: code }, raw: true }) : null;
  if (!p) return res.status(404).json({ error: `No product with barcode ${code}.` });
  res.json(toDto(p, (await sellableByProduct([p.id])).get(p.id)));
}));

router.get("/products/:id", safe(async (req, res) => {
  const p = await Product.findByPk(Number(req.params.id) || 0, { raw: true });
  if (!p) return res.status(404).json({ error: "Product not found (it may be archived)." });
  const lots = await Batch.findAll({
    where: { productId: p.id, status: "active", quantity: { [Op.gt]: 0 }, expiryDate: { [Op.gt]: todayStr() } },
    attributes: ["id", "batchNumber", "expiryDate", "quantity"], order: [["expiryDate", "ASC"], ["id", "ASC"]], raw: true
  });
  res.json({ ...toDto(p, (await sellableByProduct([p.id])).get(p.id)), lots });
}));

const saleDto = (sale, { products, lots, voided }) => ({
  reference: sale.external_ref, inventoryReference: sale.reference, total: Number(sale.total), voided,
  cashier: sale.cashier, createdAt: sale.createdAt,
  lines: (sale.items || []).map(i => ({
    productId: i.product_id, name: products.get(i.product_id)?.name ?? null, barcode: products.get(i.product_id)?.barcode ?? null,
    lotId: i.lot_id, lotNumber: lots.get(i.lot_id)?.batchNumber ?? null, lotExpiry: lots.get(i.lot_id)?.expiryDate ?? null,
    quantity: i.qty, unitPrice: Number(i.unit_price)
  }))
});

// Names, barcodes and lot numbers for a sale's lines (receipts on the POS show the lot numbers).
async function productNames(sale) {
  const ids = [...new Set((sale.items || []).map(i => i.product_id))];
  const lotIds = [...new Set((sale.items || []).map(i => i.lot_id).filter(Boolean))];
  const [rows, lotRows, voided] = await Promise.all([
    ids.length ? Product.findAll({ where: { id: ids }, attributes: ["id", "name", "barcode"], paranoid: false, raw: true }) : [],
    lotIds.length ? Batch.findAll({ where: { id: lotIds }, attributes: ["id", "batchNumber", "expiryDate"], raw: true }) : [],
    isPosSaleVoided(sale)
  ]);
  return { products: new Map(rows.map(r => [r.id, r])), lots: new Map(lotRows.map(l => [l.id, l])), voided };
}

// Body: { reference: "PC-...", cashier: "Ana", items: [{ barcode | productId, qty, unit?: "piece" | "box", unitPrice? }] }
// qty and unitPrice are per unit (a box price when unit is "box"). Response lines are always in pieces.
// 201 = recorded, 200 = this reference was already recorded (safe retry), 409 = not enough stock / unknown product.
router.post("/sales", safe(async (req, res) => {
  const reference = String(req.body?.reference || "").trim();
  if (!REF_PATTERN.test(reference)) return res.status(400).json({ error: "reference (the POS receipt number, 3-64 characters) is required." });
  const rawItems = req.body?.items;
  if (!Array.isArray(rawItems) || !rawItems.length || rawItems.length > 200) {
    return res.status(400).json({ error: "items must be a list of 1-200 lines." });
  }

  const items = [];
  for (const [index, raw] of rawItems.entries()) {
    const qty = Number(raw?.qty ?? raw?.quantity);
    if (!Number.isInteger(qty) || qty <= 0 || qty > 100000) return res.status(400).json({ error: `Line ${index + 1}: qty must be a whole number greater than 0.` });
    let productId = Number(raw?.productId) || null;
    if (!productId && raw?.barcode) {
      const p = await Product.findOne({ where: { barcode: String(raw.barcode).trim().slice(0, 64) }, attributes: ["id"], raw: true });
      if (!p) return res.status(409).json({ error: `Line ${index + 1}: no product with barcode ${raw.barcode} in inventory.`, line: index + 1 });
      productId = p.id;
    }
    if (!productId) return res.status(400).json({ error: `Line ${index + 1}: productId or barcode is required.` });
    const unitPrice = raw?.unitPrice === undefined || raw?.unitPrice === null ? undefined : Number(raw.unitPrice);
    if (unitPrice !== undefined && (!Number.isFinite(unitPrice) || unitPrice < 0)) {
      return res.status(400).json({ error: `Line ${index + 1}: unitPrice must be 0 or more.` });
    }
    const unit = raw?.unit === undefined || raw?.unit === null || raw?.unit === "piece" ? "piece" : raw.unit === "box" ? "box" : null;
    if (!unit) return res.status(400).json({ error: `Line ${index + 1}: unit must be "piece" or "box".` });
    items.push({ productId, qty, unit, unitPrice });
  }

  const { sale, duplicate } = await recordPosSale(items, req.posUser, { externalRef: reference, cashier: req.posCashier });
  res.status(duplicate ? 200 : 201).json({ duplicate, sale: saleDto(sale, await productNames(sale)) });
}));

router.get("/sales/:reference", safe(async (req, res) => {
  const sale = await findPosSale(String(req.params.reference));
  if (!sale) return res.status(404).json({ error: "No synced sale with that reference." });
  res.json(saleDto(sale, await productNames(sale)));
}));

// Body: { reason: "Wrong item scanned", approvedBy: "Admin name", cashier?: "Ana" }
router.post("/sales/:reference/void", safe(async (req, res) => {
  const reference = String(req.params.reference);
  const reason = String(req.body?.reason || "").trim();
  if (reason.length < 3) return res.status(400).json({ error: "A void reason of at least 3 characters is required." });
  const approvedBy = String(req.body?.approvedBy || "").trim().slice(0, 60);
  // 404 (not 409) so the POS can tell "this sale was never synced" (e.g. made before the integration) from a real failure.
  if (!(await findPosSale(reference))) return res.status(404).json({ error: `No synced sale with POS reference ${reference}.` });
  const fullReason = `POS void ${reference}: ${reason}${approvedBy ? ` (approved by ${approvedBy})` : ""}`;
  const result = await voidPosSale(reference, fullReason, req.posUser);
  res.json({ reference, alreadyVoided: result.alreadyVoided, linesReversed: result.linesReversed });
}));

// Business-rule failures (not enough stock, unknown product, already voided...) become JSON, never an HTML page.
router.use((err, req, res, next) => {
  if (err instanceof StockError) return res.status(409).json({ error: err.message });
  if (err?.type === "entity.parse.failed") return res.status(400).json({ error: "Request body is not valid JSON." });
  console.error("[POS API]", err);
  res.status(500).json({ error: "Inventory server error. The sale was not recorded; it is safe to retry." });
});

export default router;
