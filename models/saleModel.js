import { DataTypes } from "sequelize";
import { sequelize } from "./db.js";


export const Sale = sequelize.define("Sale", {
  reference: { type: DataTypes.STRING(40), allowNull: false },   // SALE-... (receipt number)
  user_id: { type: DataTypes.INTEGER, allowNull: true },
  total: { type: DataTypes.DECIMAL(12, 2), allowNull: false, defaultValue: 0 },
  source: { type: DataTypes.STRING(20), allowNull: true },          // "pos" for sales pushed by the POS API; NULL = local
  external_ref: { type: DataTypes.STRING(64), allowNull: true },    // POS receipt number (PC-...) - makes POS retries idempotent
  cashier: { type: DataTypes.STRING(100), allowNull: true }         // POS cashier name snapshot
}, {
  tableName: "Sales",
  underscored: true,
  updatedAt: false,
  indexes: [
    { unique: true, fields: ["reference"], name: "sales_reference_unique" },
    { unique: true, fields: ["external_ref"], name: "sales_external_ref_unique" }, // many NULLs allowed

    { fields: ["created_at"], name: "sales_created_at" }
  ]
});
