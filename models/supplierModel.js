import { DataTypes } from "sequelize";
import { sequelize } from "./db.js";

// Suppliers that deliver stock. Each Stock In records the supplier (id + name snapshot) and the delivery
// receipt / invoice number, so every lot can be traced back to the delivery it came from.
// Soft delete only (paranoid): an archived supplier stays attached to its past deliveries.
export const Supplier = sequelize.define("Supplier", {
  name: { type: DataTypes.STRING(120), allowNull: false },
  contactPerson: { type: DataTypes.STRING(120), allowNull: true },
  phone: { type: DataTypes.STRING(40), allowNull: true },
  email: { type: DataTypes.STRING(120), allowNull: true },
  address: { type: DataTypes.STRING(255), allowNull: true }
}, {
  paranoid: true,
  indexes: [{ unique: true, fields: ["name"], name: "suppliers_name_unique" }],
  hooks: {
    beforeDestroy: (i, options) => { if (options.force) throw new Error("Suppliers cannot be permanently deleted. Archive them instead."); },
    beforeBulkDestroy: options => { if (options.force) throw new Error("Suppliers cannot be permanently deleted. Archive them instead."); }
  }
});
