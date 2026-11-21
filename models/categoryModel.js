import { DataTypes } from "sequelize";
import { sequelize } from "./db.js";

// Product categories managed by admins (Categories page). Products keep the category name as text,
// so renaming a category also renames it on its products (services/catalogService.js).
export const Category = sequelize.define("Category", {
  name: { type: DataTypes.STRING(80), allowNull: false },
  description: { type: DataTypes.STRING(255), allowNull: true }
}, {
  indexes: [{ unique: true, fields: ["name"], name: "categories_name_unique" }]
});
