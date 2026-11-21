// Read-only aggregates for the Overview dashboard (GET /api/dashboard/stats).
// Timestamps are stored in UTC (Sequelize default); buckets and "today/this month" use the server's local time,
// so a sale at 7:30 AM in Manila counts on that local day, not the previous UTC day.
import { QueryTypes } from "sequelize";
import { sequelize } from "../models/db.js";

export class AnalyticsError extends Error {}

export const RANGES = {
  daily:   { fmt: "%Y-%m-%d", default: 30, max: 366, unit: "day" },
  monthly: { fmt: "%Y-%m",    default: 12, max: 120, unit: "month" },
  yearly:  { fmt: "%Y",       default: 5,  max: 20,  unit: "year" }
};

// A sale line counts unless its DISPENSED stock movement was VOIDed (= the sale was cancelled).
const NOT_VOIDED_LOG = `NOT EXISTS (SELECT 1 FROM StockLogs v WHERE v.voidOfId = l.id)`;

const DAY = 86400000;
const pad = n => String(n).padStart(2, "0");
const tzOffset = () => {
  const m = -new Date().getTimezoneOffset();
  return `${m < 0 ? "-" : "+"}${pad(Math.floor(Math.abs(m) / 60))}:${pad(Math.abs(m) % 60)}`;
};
const localDay = d => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parseYmd = s => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(s || ""))) return null;
  const [y, m, d] = s.split("-").map(Number);
  const date = new Date(y, m - 1, d);
  return date.getMonth() === m - 1 ? date : null; // rejects 2026-02-31
};
const round2 = n => Math.round((Number(n) || 0) * 100) / 100;

const bucketStart = (d, unit) => unit === "day" ? localDay(d) : unit === "month" ? new Date(d.getFullYear(), d.getMonth(), 1) : new Date(d.getFullYear(), 0, 1);
const nextBucket = (d, unit) => unit === "day" ? new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1)
  : unit === "month" ? new Date(d.getFullYear(), d.getMonth() + 1, 1) : new Date(d.getFullYear() + 1, 0, 1);
const keyOf = (d, unit) => unit === "day" ? ymd(d) : unit === "month" ? `${d.getFullYear()}-${pad(d.getMonth() + 1)}` : String(d.getFullYear());
const labelOf = (d, unit) => unit === "day" ? d.toLocaleDateString("en-PH", { month: "short", day: "numeric" })
  : unit === "month" ? d.toLocaleDateString("en-PH", { month: "short", year: "numeric" }) : String(d.getFullYear());

// Resolves ?range=&from=&to= into a [start, end) window of whole buckets.
export function resolveWindow({ range = "daily", from, to } = {}, now = new Date()) {
  const spec = RANGES[range];
  if (!spec) throw new AnalyticsError("range must be daily, monthly or yearly.");
  const fromDate = from ? parseYmd(from) : null;
  const toDate = to ? parseYmd(to) : null;
  if ((from && !fromDate) || (to && !toDate)) throw new AnalyticsError("from/to must be valid dates (YYYY-MM-DD).");
  if (fromDate && toDate && fromDate > toDate) throw new AnalyticsError("from must be on or before to.");

  const endBucket = bucketStart(toDate || now, spec.unit);
  let start;
  if (fromDate) start = bucketStart(fromDate, spec.unit);
  else {
    start = endBucket;
    for (let i = 1; i < spec.default; i++) start = spec.unit === "day" ? new Date(start.getFullYear(), start.getMonth(), start.getDate() - 1)
      : spec.unit === "month" ? new Date(start.getFullYear(), start.getMonth() - 1, 1) : new Date(start.getFullYear() - 1, 0, 1);
  }
  const buckets = [];
  for (let d = start; d <= endBucket; d = nextBucket(d, spec.unit)) {
    buckets.push({ key: keyOf(d, spec.unit), label: labelOf(d, spec.unit) });
    if (buckets.length > spec.max) throw new AnalyticsError(`That range is too long for a ${range} view (max ${spec.max} ${spec.unit}s). Pick a coarser view or a shorter range.`);
  }
  return { range, unit: spec.unit, fmt: spec.fmt, start, end: nextBucket(endBucket, spec.unit), buckets };
}

const q = (sql, replacements) => sequelize.query(sql, { type: QueryTypes.SELECT, replacements });

async function movementSeries(win, tz) {
  // Every lot movement counts by its sign: deliveries and voided dispenses are "in"; dispensing, write-offs
  // and voided deliveries are "out". Product edits (amount 0, no lot) are ignored.
  const rows = await q(`
    SELECT DATE_FORMAT(CONVERT_TZ(l.createdAt, '+00:00', :tz), :fmt) AS k,
           SUM(GREATEST(l.amount, 0)) AS qin, SUM(GREATEST(-l.amount, 0)) AS qout
    FROM StockLogs l WHERE l.batchId IS NOT NULL AND l.createdAt >= :start AND l.createdAt < :end GROUP BY k`,
  { tz, fmt: win.fmt, start: win.start, end: win.end });
  const byKey = new Map(rows.map(r => [r.k, r]));
  return win.buckets.map(b => ({ label: b.label, key: b.key, in: Number(byKey.get(b.key)?.qin) || 0, out: Number(byKey.get(b.key)?.qout) || 0 }));
}

async function expiryRisk(now) {
  const today = localDay(now);
  const limit = ymd(new Date(today.getFullYear(), today.getMonth(), today.getDate() + 90));
  // Active lots still on the shelf. Lots already past expiry but not yet written off are included: that stock is at risk now.
  const lots = await q(`
    SELECT b.quantity, b.expiryDate, p.price FROM Batches b JOIN Products p ON p.id = b.productId AND p.deletedAt IS NULL
    WHERE b.status = 'active' AND b.quantity > 0 AND b.expiryDate <= :limit`, { limit });
  const out = {};
  for (const days of [30, 60, 90]) {
    const cutoff = ymd(new Date(today.getFullYear(), today.getMonth(), today.getDate() + days));
    const hit = lots.filter(l => (l.expiryDate instanceof Date ? ymd(l.expiryDate) : String(l.expiryDate).slice(0, 10)) <= cutoff);
    out[`d${days}`] = {
      lots: hit.length,
      units: hit.reduce((s, l) => s + Number(l.quantity), 0),
      value: round2(hit.reduce((s, l) => s + Number(l.quantity) * Number(l.price), 0))
    };
  }
  return out;
}

async function stockHealth(now) {
  const since30 = new Date(now.getTime() - 30 * DAY);
  const since60 = new Date(now.getTime() - 60 * DAY);
  // Demand = DISPENSED movements that were not voided (expiries and recalls are not demand).
  const products = await q(`
    SELECT p.id, p.name, p.category, p.quantity, p.price,
      (SELECT COALESCE(SUM(-l.amount), 0) FROM StockLogs l WHERE l.productId = p.id AND l.action = 'DISPENSED' AND l.createdAt >= :since30 AND ${NOT_VOIDED_LOG}) AS out30,
      (SELECT COUNT(*) FROM StockLogs l WHERE l.productId = p.id AND l.action = 'DISPENSED' AND l.createdAt >= :since60 AND ${NOT_VOIDED_LOG}) AS outs60,
      (SELECT MAX(l.createdAt) FROM StockLogs l WHERE l.productId = p.id AND l.action = 'DISPENSED' AND ${NOT_VOIDED_LOG}) AS lastOut
    FROM Products p WHERE p.deletedAt IS NULL ORDER BY p.name`, { since30, since60 });

  const daysOfStock = products.map(p => {
    const avgDailyOut = Math.round((Number(p.out30) / 30) * 100) / 100;
    return {
      id: p.id, product: p.name, qty: Number(p.quantity), avgDailyOut,
      daysLeft: avgDailyOut > 0 ? Math.round((p.quantity / avgDailyOut) * 10) / 10 : null // null = no recent demand
    };
  }).sort((a, b) => (a.daysLeft ?? Infinity) - (b.daysLeft ?? Infinity) || a.product.localeCompare(b.product));

  // Products with stock on the shelf but nothing dispensed in 60 days.
  const slowMovers = products
    .filter(p => Number(p.outs60) === 0 && Number(p.quantity) > 0)
    .map(p => ({ id: p.id, product: p.name, category: p.category, qty: Number(p.quantity), value: round2(p.quantity * p.price), lastOut: p.lastOut ? new Date(p.lastOut).toISOString() : null }))
    .sort((a, b) => b.value - a.value);

  return { daysOfStock, slowMovers };
}

async function categoryValue() {
  const rows = await q(`
    SELECT category, SUM(quantity * price) AS value FROM Products WHERE deletedAt IS NULL
    GROUP BY category HAVING value > 0 ORDER BY value DESC`);
  return rows.map(r => ({ category: r.category, value: round2(r.value) }));
}

export async function dashboardStats(query = {}, now = new Date()) {
  const win = resolveWindow(query, now);
  const tz = tzOffset();
  // Inventory figures only: sales are reported by the POS system.
  const [movement, risk, health, categories] = await Promise.all([
    movementSeries(win, tz), expiryRisk(now), stockHealth(now), categoryValue()
  ]);
  return {
    range: win.range,
    from: ymd(win.start),
    to: ymd(new Date(win.end.getTime() - DAY)),
    movementSeries: movement,
    expiryRisk: risk,
    daysOfStock: health.daysOfStock,
    slowMovers: health.slowMovers,
    categoryValue: categories
  };
}
