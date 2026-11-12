import { DataTypes } from "sequelize";
import { sequelize } from "./db.js";

// Soft-delete policy: `paranoid: true` makes Sequelize add a `deletedAt` column.
// product.destroy() runs `UPDATE Products SET deletedAt = NOW()` (never DELETE FROM),
// and every normal query automatically hides archived rows (WHERE deletedAt IS NULL).
const blockHardDelete = options => {
  if (options.force) throw new Error("Permanent deletion of products is disabled (audit policy). Archive the product instead.");
};

export const Product = sequelize.define("Product", {
  name: { type: DataTypes.STRING, allowNull: false },
  category: { type: DataTypes.STRING, allowNull: false },
  // Cached total of all ACTIVE batches. Never edited directly - recalculated by services/stockService.js.
  quantity: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
  // Nearest expiry among active batches with stock (null when out of stock).
  expiry: { type: DataTypes.DATEONLY, allowNull: true },
  price: { type: DataTypes.DECIMAL(10, 2), allowNull: false, defaultValue: 0 },
  // Optional manufacturer barcode (EAN/UPC/GTIN) so a USB scanner can find the product. NULL = none.
  barcode: { type: DataTypes.STRING(64), allowNull: true },
  deletedById: { type: DataTypes.INTEGER, allowNull: true },
  deleteReason: { type: DataTypes.STRING, allowNull: true }
}, {
  paranoid: true,
  // Named so `sync({ alter: true })` does not add a duplicate index on every migrate. Many NULLs are allowed.
  indexes: [{ unique: true, fields: ["barcode"], name: "products_barcode_unique" }],
  hooks: {
    beforeDestroy: (instance, options) => blockHardDelete(options),
    beforeBulkDestroy: options => blockHardDelete(options)
  }
});
