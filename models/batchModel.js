import { DataTypes } from "sequelize";
import { sequelize } from "./db.js";
import { Product } from "./productModel.js";

// One row per manufacturer Batch/Lot number of a product. Quantities and expiry dates live here,
// so a recall of e.g. "Amoxicillin lot AMX24051" can be traced to exact stock movements.
const noDelete = () => { throw new Error("Batches cannot be deleted (audit policy). Use expire or recall instead."); };

export const BATCH_STATUSES = ["active", "expired", "recalled"];

export const Batch = sequelize.define("Batch", {
  productId: { type: DataTypes.INTEGER, allowNull: false },
  batchNumber: { type: DataTypes.STRING(50), allowNull: false },
  manufacturer: { type: DataTypes.STRING, allowNull: true },
  quantity: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0, validate: { min: 0 } },
  expiryDate: { type: DataTypes.DATEONLY, allowNull: false },
  receivedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
  status: { type: DataTypes.ENUM(...BATCH_STATUSES), allowNull: false, defaultValue: "active" }
}, {
  indexes: [{ unique: true, fields: ["productId", "batchNumber"], name: "batches_product_lot_unique" }],
  hooks: { beforeDestroy: noDelete, beforeBulkDestroy: noDelete }
});

Product.hasMany(Batch, { foreignKey: "productId", as: "batches", constraints: false });
Batch.belongsTo(Product, { foreignKey: "productId", as: "productRef", constraints: false });
