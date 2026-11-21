import { DataTypes } from "sequelize";
import { sequelize } from "./db.js";

// Every action code the ledger can hold, with how the dashboard shows it.
export const ACTION_META = {
  PRODUCT_ADDED:    { label: "Product added",     badge: "badge-blue" },
  PRODUCT_UPDATED:  { label: "Product updated",   badge: "badge-gray" },
  PRODUCT_ARCHIVED: { label: "Product archived",  badge: "badge-gray" },
  PRODUCT_RESTORED: { label: "Product restored",  badge: "badge-blue" },
  STOCK_IN:         { label: "Stock received",    badge: "badge-green" },
  DISPENSED:        { label: "Dispensed",         badge: "badge-purple" }, // sales (from the POS)
  STOCK_OUT:        { label: "Stock out",         badge: "badge-slate" },  // damaged, internal use, transfer... (reason required)
  EXPIRED:          { label: "Expired write-off", badge: "badge-orange" },
  RECALLED:         { label: "Recalled",          badge: "badge-amber" },
  ADJUSTMENT:       { label: "Stock adjustment",  badge: "badge-gray" }, // legacy rows only
  VOID:             { label: "VOID",              badge: "badge-red" }
};
export const ACTIONS = Object.keys(ACTION_META);
// Movements that can be reversed by a VOID entry.
export const VOIDABLE = ["STOCK_IN", "DISPENSED", "STOCK_OUT", "EXPIRED", "RECALLED"];

// The ledger is append-only: no updates, no deletes. MySQL triggers created by migrate.js
// enforce the same rule at the database level (even raw SQL cannot change or remove a log).
const immutable = () => { throw new Error("Stock logs are immutable. Record a VOID entry instead of editing or deleting."); };

export const StockLog = sequelize.define("StockLog", {
  action: { type: DataTypes.STRING(30), allowNull: false, validate: { isIn: [ACTIONS] } },
  productId: { type: DataTypes.INTEGER, allowNull: true },
  product: { type: DataTypes.STRING, allowNull: false },          // product name snapshot
  batchId: { type: DataTypes.INTEGER, allowNull: true },
  batchNumber: { type: DataTypes.STRING(50), allowNull: true },   // lot number snapshot
  amount: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 }, // signed quantity change
  balanceAfter: { type: DataTypes.INTEGER, allowNull: true },     // product on-hand after this movement
  userId: { type: DataTypes.INTEGER, allowNull: true },
  user: { type: DataTypes.STRING, allowNull: false },             // staff name snapshot
  reason: { type: DataTypes.STRING(255), allowNull: true },
  reference: { type: DataTypes.STRING(40), allowNull: true },     // groups lines of one transaction (DSP-..., RCV-...)
  voidOfId: { type: DataTypes.INTEGER, allowNull: true },         // for VOID rows: the log entry being reversed
  // How the quantity was entered when it was not in pieces, e.g. entryUnit "box", entryQty 10 (amount holds the pieces).
  entryUnit: { type: DataTypes.STRING(10), allowNull: true },
  entryQty: { type: DataTypes.INTEGER, allowNull: true },
  // Stock In only: who delivered it (id + name snapshot). The delivery receipt / invoice no. is `reference`.
  supplierId: { type: DataTypes.INTEGER, allowNull: true },
  supplier: { type: DataTypes.STRING(120), allowNull: true }
}, {
  updatedAt: false,
  indexes: [
    { unique: true, fields: ["voidOfId"], name: "stocklogs_void_of_unique" }, // a movement can be voided only once
    { fields: ["reference"], name: "stocklogs_reference" },
    { fields: ["batchNumber"], name: "stocklogs_batch_number" }
  ],
  hooks: {
    beforeUpdate: immutable, beforeBulkUpdate: immutable,
    beforeDestroy: immutable, beforeBulkDestroy: immutable
  }
});
