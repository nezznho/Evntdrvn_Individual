import { DataTypes } from "sequelize";
import { sequelize } from "./db.js";

export const StockLog = sequelize.define("StockLog", {
  action: { type: DataTypes.STRING, allowNull: false },
  product: { type: DataTypes.STRING, allowNull: false },
  amount: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
  user: { type: DataTypes.STRING, allowNull: false }
});