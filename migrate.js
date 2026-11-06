import { Sequelize } from "sequelize";
import { sequelize } from "./models/db.js";
import "./models/userModel.js";
import "./models/productModel.js";
import "./models/stockLogModel.js";
import { User } from "./models/userModel.js";
import { Product } from "./models/productModel.js";
import { StockLog } from "./models/stockLogModel.js";

const rootSequelize = new Sequelize("mysql", "root", "", { host: "localhost", dialect: "mysql" });

try {
  await rootSequelize.query("CREATE DATABASE IF NOT EXISTS `Pharmacare`");
  await sequelize.authenticate();
  await sequelize.sync({ alter: true });
  if (await User.count() === 0) await User.bulkCreate([
    { name: "Alex Morgan", email: "admin@pharma.com", password: "admin123", role: "admin" },
    { name: "Jamie Wilson", email: "staff@pharma.com", password: "staff123", role: "staff" }
  ]);
  if (await Product.count() === 0) await Product.bulkCreate([
    { name: "Amoxicillin 500mg", category: "Antibiotics", quantity: 24, expiry: "2026-12-15", price: 12.50 },
    { name: "Paracetamol 500mg", category: "Pain Relief", quantity: 148, expiry: "2027-06-30", price: 4.25 },
    { name: "Cetirizine 10mg", category: "Antihistamines", quantity: 9, expiry: "2027-01-20", price: 7.80 },
    { name: "Metformin 850mg", category: "Diabetes", quantity: 32, expiry: "2026-11-28", price: 9.40 },
    { name: "Omeprazole 20mg", category: "Digestive Health", quantity: 7, expiry: "2027-04-12", price: 11.20 },
    { name: "Vitamin C 1000mg", category: "Supplements", quantity: 86, expiry: "2027-08-05", price: 6.75 },
    { name: "Salbutamol Inhaler", category: "Respiratory", quantity: 18, expiry: "2026-12-01", price: 18.90 }
  ]);
  if (await StockLog.count() === 0) await StockLog.bulkCreate([
    { action: "Stock received", product: "Amoxicillin 500mg", amount: 50, user: "Alex Morgan" },
    { action: "Dispensed", product: "Paracetamol 500mg", amount: -12, user: "Jamie Wilson" }
  ]);
  console.log("✅ Pharmacare database and tables are ready");
} catch (error) {
  console.error("❌ Migration failed:", error.message); process.exitCode = 1;
} finally { await rootSequelize.close(); await sequelize.close(); }