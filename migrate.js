import { Sequelize, Op } from "sequelize";
import { sequelize } from "./models/db.js";
import { User } from "./models/userModel.js";
import { Product } from "./models/productModel.js";
import { Batch } from "./models/batchModel.js";
import { StockLog } from "./models/stockLogModel.js";
import * as stock from "./services/stockService.js";

const DB = sequelize.config.database;
const rootSequelize = new Sequelize("mysql", "root", "", { host: "localhost", dialect: "mysql", logging: false });

// Database-level guards: even raw SQL (phpMyAdmin, a buggy query) cannot hard-delete records or rewrite the ledger.
const TRIGGERS = [
  ["trg_stocklogs_no_update", "BEFORE UPDATE ON `StockLogs`", "Stock logs are immutable - record a VOID entry instead"],
  ["trg_stocklogs_no_delete", "BEFORE DELETE ON `StockLogs`", "Stock logs cannot be deleted"],
  ["trg_products_no_delete",  "BEFORE DELETE ON `Products`",  "Products cannot be deleted - archive them (soft delete)"],
  ["trg_batches_no_delete",   "BEFORE DELETE ON `Batches`",   "Batches cannot be deleted - expire or recall them"],
  ["trg_users_no_delete",     "BEFORE DELETE ON `Users`",     "Staff accounts cannot be deleted - deactivate them"]
];
const dropTriggers = () => Promise.all(TRIGGERS.map(([name]) => sequelize.query(`DROP TRIGGER IF EXISTS \`${name}\``)));
const createTriggers = async () => {
  for (const [name, timing, message] of TRIGGERS) {
    await sequelize.query(`CREATE TRIGGER \`${name}\` ${timing} FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = '${message}'`);
  }
};

// Old free-text actions -> new action codes (one-time data migration for existing databases).
const LEGACY_ACTIONS = {
  "Product added": "PRODUCT_ADDED", "Product updated": "PRODUCT_UPDATED", "Product deleted": "PRODUCT_ARCHIVED",
  "Stock received": "STOCK_IN", "Stock adjustment": "ADJUSTMENT", "Dispensed": "DISPENSED"
};

async function migrateLegacyData() {
  // Products.barcode is added by sync({ alter: true }). Blank strings (e.g. typed in phpMyAdmin) would collide on the unique index.
  await sequelize.query("UPDATE `Products` SET `barcode` = NULL WHERE `barcode` = ''");
  for (const [old, code] of Object.entries(LEGACY_ACTIONS)) {
    await sequelize.query("UPDATE `StockLogs` SET `action` = ? WHERE `action` = ?", { replacements: [code, old] });
  }
  await sequelize.query("UPDATE `StockLogs` l JOIN `Products` p ON p.`name` = l.`product` SET l.`productId` = p.`id` WHERE l.`productId` IS NULL");
  await sequelize.query("UPDATE `StockLogs` l JOIN `Users` u ON u.`name` = l.`user` SET l.`userId` = u.`id` WHERE l.`userId` IS NULL");

  // Products that have stock but no lots yet (created before batch tracking) get a placeholder lot.
  const products = await Product.findAll({ paranoid: false, where: { quantity: { [Op.gt]: 0 } } });
  for (const p of products) {
    if (await Batch.count({ where: { productId: p.id } })) continue;
    const batch = await Batch.create({ productId: p.id, batchNumber: `LEGACY-${p.id}`, quantity: p.quantity, expiryDate: p.expiry || "2099-12-31", manufacturer: "Unknown (pre-batch tracking)" });
    // Opening-balance ledger entry so the lot's history adds up (ADJUSTMENT = not voidable).
    await StockLog.create({ action: "ADJUSTMENT", productId: p.id, product: p.name, batchId: batch.id, batchNumber: batch.batchNumber,
      amount: p.quantity, balanceAfter: p.quantity, user: "System migration", reason: "Opening balance carried over from pre-batch inventory", reference: "MIGRATION" });
    console.log(`  ↳ ${p.name}: created placeholder lot LEGACY-${p.id} for ${p.quantity} existing unit(s)`);
  }
}

async function seed() {
  if (await User.count({ paranoid: false }) === 0) await User.bulkCreate([
    { name: "Alex Morgan", email: "admin@pharma.com", password: "admin123", role: "admin" },
    { name: "Jamie Wilson", email: "staff@pharma.com", password: "staff123", role: "staff" }
  ]);
  if (await Product.count({ paranoid: false }) > 0) return;

  const admin = (await User.findOne({ where: { role: "admin" } })).get({ plain: true });
  const staff = (await User.findOne({ where: { role: "staff" } }) || await User.findOne()).get({ plain: true });
  const items = [
    ["Amoxicillin 500mg", "Antibiotics", 12.50, [["AMX24051", "2026-12-15", 24, "Unilab"], ["AMX25012", "2027-09-30", 60, "Unilab"]]],
    ["Alaxan FR", "Pain Relief", 8.75, [["ALX2508B", "2027-05-31", 120, "Unilab"]]],
    ["Paracetamol 500mg", "Pain Relief", 4.25, [["PCM2503A", "2027-06-30", 148, "RiteMED"]]],
    ["Cetirizine 10mg", "Antihistamines", 7.80, [["CTZ2501C", "2027-01-20", 9, "Pascual Lab"]]],
    ["Metformin 850mg", "Diabetes", 9.40, [["MTF2410X", "2026-11-28", 32, "Getz Pharma"]]],
    ["Omeprazole 20mg", "Digestive Health", 11.20, [["OMP2504D", "2027-04-12", 7, "RiteMED"]]],
    ["Vitamin C 1000mg", "Supplements", 6.75, [["VTC2507E", "2027-08-05", 86, "Pascual Lab"]]],
    ["Salbutamol Inhaler", "Respiratory", 18.90, [["SLB2411F", "2026-12-01", 18, "GSK"]]]
  ];
  const ids = {};
  for (const [name, category, price, lots] of items) {
    const p = await stock.createProduct({ name, category, price }, admin);
    ids[name] = p.id;
    for (const [batchNumber, expiryDate, quantity, manufacturer] of lots) {
      await stock.stockIn(p.id, { batchNumber, expiryDate, quantity, manufacturer }, admin);
    }
  }
  // Sample movements so the audit trail has something to show during the demo.
  await stock.dispense(ids["Paracetamol 500mg"], { quantity: 12 }, staff);
  await stock.dispense(ids["Amoxicillin 500mg"], { quantity: 30 }, staff); // FEFO: spans both Amoxicillin lots
  const voidable = await stock.dispense(ids["Alaxan FR"], { quantity: 5 }, staff);
  const line = await StockLog.findOne({ where: { reference: voidable } });
  await stock.voidTransaction(line.id, "Customer cancelled before payment", admin);
}

try {
  await rootSequelize.query(`CREATE DATABASE IF NOT EXISTS \`${DB}\``);
  await sequelize.authenticate();
  await dropTriggers().catch(() => {}); // tables may not exist yet on a fresh database
  await sequelize.sync({ alter: true });
  await migrateLegacyData();
  await seed();
  await createTriggers();
  console.log(`✅ ${DB} database and tables are ready (soft deletes, batch tracking, immutable audit log)`);
} catch (error) {
  console.error("❌ Migration failed:", error.message); process.exitCode = 1;
} finally { await rootSequelize.close(); await sequelize.close(); }
