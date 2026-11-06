import { DataTypes } from "sequelize";
import { sequelize } from "./db.js";

export const Product = sequelize.define("Product", {
  name: { type: DataTypes.STRING, allowNull: false },
  category: { type: DataTypes.STRING, allowNull: false },
  quantity: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
  expiry: { type: DataTypes.DATEONLY, allowNull: false },
  price: { type: DataTypes.DECIMAL(10, 2), allowNull: false, defaultValue: 0 }
});s