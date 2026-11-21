import { Sequelize, Op } from "sequelize";
import { sequelize } from "./models/db.js";
import { User, isHashed } from "./models/userModel.js";
import { Category } from "./models/categoryModel.js";   // registers the Categories table for sync()
import { Supplier } from "./models/supplierModel.js";   // registers the Suppliers table for sync()
import { BASE_CATEGORIES } from "./services/catalogService.js";
import { Product } from "./models/productModel.js";
import { Batch } from "./models/batchModel.js";
import { StockLog } from "./models/stockLogModel.js";
import { Sale } from "./models/saleModel.js";          // registers the Sales table for sync()
import { SaleItem } from "./models/saleItemModel.js";  // registers the SaleItems table for sync()
import * as stock from "./services/stockService.js";
import { recordSale } from "./services/saleService.js";

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
  // Passwords: convert any plain-text password to a bcrypt hash (the User model hook hashes on update).
  let hashed = 0;
  for (const u of await User.findAll({ paranoid: false })) {
    if (isHashed(u.password)) continue;
    u.changed("password", true); // same value, so mark it changed or the hashing hook would skip it
    await u.save({ fields: ["password"] });
    hashed++;
  }
  if (hashed) console.log(`  ↳ ${hashed} plain-text password(s) converted to bcrypt hashes`);

  // Categories: the defaults plus every category already used by a product.
  const [used] = await sequelize.query("SELECT DISTINCT `category` AS name FROM `Products` WHERE `category` IS NOT NULL AND `category` <> ''");
  for (const name of new Set([...BASE_CATEGORIES, ...used.map(r => r.name)])) {
    await Category.findOrCreate({ where: { name }, defaults: { name } });
  }

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
  if (await Product.count({ paranoid: false }) > 0) return false;

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
  return true; // fresh demo database
}

// Sample sales so the Overview analytics have something to show until the POS module writes real ones.
// Each sale goes through saleService -> stockService (FEFO, lot quantities, DISPENSED logs), so stock stays consistent.
// The sale rows are back-dated across the last few years; their stock logs are dated today (the ledger is append-only).
// Runs automatically on a fresh demo database, or on demand with `npm run seed:sales` (only while SaleItems is empty).
async function seedSales() {
  if (await SaleItem.count() > 0) { console.log("  ↳ Sales already exist, sample sales skipped."); return; }
  const user = (await User.findOne({ where: { role: "staff" } }) || await User.findOne()).get({ plain: true });
  // The five best-stocked products; the rest stay unsold so the "slow movers" table has examples.
  const products = await Product.findAll({ where: { quantity: { [Op.gte]: 20 } }, order: [["quantity", "DESC"]], limit: 5, raw: true });
  if (!products.length) { console.log("  ↳ No products with enough stock for sample sales."); return; }

  let seed = 20261117; // deterministic pseudo-random numbers -> the same sample data on every machine
  const rand = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
  const now = Date.now(), DAY = 86400000;
  const times = [
    ...Array.from({ length: 5 }, (_, i) => now - (i + 1) * 25 * 60000),            // earlier today
    ...Array.from({ length: 5 }, () => now - DAY - rand() * 6 * 3600000),           // yesterday
    ...Array.from({ length: 16 }, () => now - (2 + rand() * 28) * DAY),             // rest of the last 30 days
    ...Array.from({ length: 12 }, () => now - (30 + rand() * 335) * DAY),           // last 12 months
    ...Array.from({ length: 6 }, () => now - (365 + rand() * 4 * 365) * DAY)        // previous years
  ].sort((a, b) => a - b);

  let created = 0;
  for (const t of times) {
    const picks = [...products].sort(() => rand() - 0.5).slice(0, rand() < 0.6 ? 1 : 2);
    const items = picks.map(p => ({
      productId: p.id, qty: 1 + Math.floor(rand() * 3),
      unitPrice: Number(p.price), unitCost: Math.round(Number(p.price) * (0.66 + rand() * 0.1) * 100) / 100
    }));
    try { await recordSale(items, user, { createdAt: new Date(t) }); created++; }
    catch (err) { if (!(err instanceof stock.StockError)) throw err; } // not enough stock left: skip this sample
  }
  console.log(`  ↳ ${created} sample sale(s) recorded through stockService.`);
}

try {
  await rootSequelize.query(`CREATE DATABASE IF NOT EXISTS \`${DB}\``);
  await sequelize.authenticate();
  await dropTriggers().catch(() => {}); // tables may not exist yet on a fresh database
  await sequelize.sync({ alter: true });
  await migrateLegacyData();
  const fresh = await seed();
  if (fresh || process.argv.includes("--seed-sales")) await seedSales();
  await createTriggers();
  console.log(`✅ ${DB} database and tables are ready (soft deletes, batch tracking, immutable audit log)`);
} catch (error) {
  console.error("❌ Migration failed:", error.message); process.exitCode = 1;
} finally { await rootSequelize.close(); await sequelize.close(); }
