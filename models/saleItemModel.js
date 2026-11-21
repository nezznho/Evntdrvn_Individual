import { DataTypes } from "sequelize";
import { sequelize } from "./db.js";
import { Sale } from "./saleModel.js";
import { Product } from "./productModel.js";

// One row per product per lot sold. A sale line that FEFO splits across two lots becomes two rows,
// so revenue and cost can be traced to the exact lot (and its DISPENSED stock log via stock_ref).
export const SaleItem = sequelize.define("SaleItem", {
  sale_id: { type: DataTypes.INTEGER, allowNull: false },
  product_id: { type: DataTypes.INTEGER, allowNull: false },
  lot_id: { type: DataTypes.INTEGER, allowNull: true },             // Batches.id
  qty: { type: DataTypes.INTEGER, allowNull: false, validate: { min: 1 } },
  unit_price: { type: DataTypes.DECIMAL(10, 2), allowNull: false },  // selling price at time of sale
  unit_cost: { type: DataTypes.DECIMAL(10, 2), allowNull: true },    // NULL = cost unknown (excluded from margin)
  user_id: { type: DataTypes.INTEGER, allowNull: true },
  stock_ref: { type: DataTypes.STRING(40), allowNull: true }         // StockLogs.reference of the DISPENSED lines
}, {
  tableName: "SaleItems",
  underscored: true,
  updatedAt: false,
  indexes: [
    { fields: ["sale_id"], name: "sale_items_sale" },
    { fields: ["product_id", "created_at"], name: "sale_items_product_created" },
    { fields: ["created_at"], name: "sale_items_created_at" }
  ]
});

Sale.hasMany(SaleItem, { foreignKey: "sale_id", as: "items", constraints: false });
SaleItem.belongsTo(Sale, { foreignKey: "sale_id", as: "sale", constraints: false });
SaleItem.belongsTo(Product, { foreignKey: "product_id", as: "product", constraints: false });
