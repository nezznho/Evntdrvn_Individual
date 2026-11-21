// Categories and suppliers (admin pages). Products store the category NAME, so a rename is applied to the
// products in the same transaction; a category still used by a product cannot be deleted.
import { Op } from "sequelize";
import { sequelize } from "../models/db.js";
import { Category } from "../models/categoryModel.js";
import { Supplier } from "../models/supplierModel.js";
import { Product } from "../models/productModel.js";
import { StockLog } from "../models/stockLogModel.js";
import { StockError } from "./stockService.js";

export const BASE_CATEGORIES = ["Antibiotics", "Pain Relief", "Antihistamines", "Diabetes", "Digestive Health", "Supplements", "Respiratory"];

const clean = (value, max, field, { required = false } = {}) => {
  const text = String(value ?? "").trim().replace(/\s+/g, " ").slice(0, max);
  if (required && !text) throw new StockError(`${field} is required.`);
  return text || null;
};

// ---------- Categories ----------

export async function listCategories() {
  const [categories, counts] = await Promise.all([
    Category.findAll({ order: [["name", "ASC"]], raw: true }),
    Product.findAll({ attributes: ["category", [sequelize.fn("COUNT", sequelize.col("id")), "n"]], group: ["category"], raw: true })
  ]);
  const byName = new Map(counts.map(c => [String(c.category).toLowerCase(), Number(c.n)]));
  return categories.map(c => {
    const productCount = byName.get(c.name.toLowerCase()) || 0;
    return { ...c, productCount, productCountText: `${productCount} product${productCount === 1 ? "" : "s"}` };
  });
}

export const categoryNames = async () => (await Category.findAll({ attributes: ["name"], order: [["name", "ASC"]], raw: true })).map(c => c.name);

export async function requireCategory(name) {
  const found = name && await Category.findOne({ where: { name: String(name).trim() }, raw: true });
  if (!found) throw new StockError("Choose a category from the list (admins can add categories on the Categories page).");
  return found.name;
}

export async function createCategory(data) {
  const name = clean(data.name, 80, "Category name", { required: true });
  if (await Category.findOne({ where: { name } })) throw new StockError(`Category "${name}" already exists.`);
  return Category.create({ name, description: clean(data.description, 255) });
}

export const renameCategory = (id, data) => sequelize.transaction(async t => {
  const category = await Category.findByPk(id, { transaction: t, lock: t.LOCK.UPDATE });
  if (!category) throw new StockError("Category not found.");
  const name = clean(data.name, 80, "Category name", { required: true });
  const clash = await Category.findOne({ where: { name, id: { [Op.ne]: category.id } }, transaction: t });
  if (clash) throw new StockError(`Category "${name}" already exists.`);
  const old = category.name;
  await category.update({ name, description: clean(data.description, 255) }, { transaction: t });
  // Archived products too, so a restored product keeps a valid category.
  const [moved] = await Product.update({ category: name }, { where: { category: old }, paranoid: false, transaction: t });
  return { category, old, moved };
});

export async function deleteCategory(id) {
  const category = await Category.findByPk(id);
  if (!category) throw new StockError("Category not found.");
  const used = await Product.count({ where: { category: category.name }, paranoid: false });
  if (used) throw new StockError(`"${category.name}" is used by ${used} product(s), archived ones included. Move them to another category first.`);
  await category.destroy();
  return category;
}

// ---------- Suppliers ----------

const supplierFields = data => ({
  name: clean(data.name, 120, "Supplier name", { required: true }),
  contactPerson: clean(data.contactPerson, 120),
  phone: clean(data.phone, 40),
  email: (() => {
    const email = clean(data.email, 120);
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new StockError("Enter a valid supplier email or leave it blank.");
    return email;
  })(),
  address: clean(data.address, 255)
});

export async function listSuppliers() {
  const [suppliers, stats] = await Promise.all([
    Supplier.findAll({ order: [["name", "ASC"]], raw: true }),
    StockLog.findAll({
      where: { action: "STOCK_IN", supplierId: { [Op.ne]: null } },
      attributes: ["supplierId", [sequelize.fn("COUNT", sequelize.col("id")), "deliveries"], [sequelize.fn("MAX", sequelize.col("createdAt")), "lastDelivery"]],
      group: ["supplierId"], raw: true
    })
  ]);
  const byId = new Map(stats.map(s => [s.supplierId, s]));
  return suppliers.map(s => ({ ...s, deliveries: Number(byId.get(s.id)?.deliveries || 0), lastDelivery: byId.get(s.id)?.lastDelivery || null }));
}

export async function createSupplier(data) {
  const fields = supplierFields(data);
  const existing = await Supplier.findOne({ where: { name: fields.name }, paranoid: false });
  if (existing) throw new StockError(existing.deletedAt ? `Supplier "${fields.name}" is archived. Restore it instead.` : `Supplier "${fields.name}" already exists.`);
  return Supplier.create(fields);
}

export async function updateSupplier(id, data) {
  const supplier = await Supplier.findByPk(id);
  if (!supplier) throw new StockError("Supplier not found.");
  const fields = supplierFields(data);
  const clash = await Supplier.findOne({ where: { name: fields.name, id: { [Op.ne]: supplier.id } }, paranoid: false });
  if (clash) throw new StockError(`Supplier "${fields.name}" already exists.`);
  return supplier.update(fields);
}

export async function archiveSupplier(id) {
  const supplier = await Supplier.findByPk(id);
  if (!supplier) throw new StockError("Supplier not found.");
  await supplier.destroy(); // soft delete: past deliveries keep their supplier
  return supplier;
}

export async function restoreSupplier(id) {
  const supplier = await Supplier.findByPk(id, { paranoid: false });
  if (!supplier?.deletedAt) throw new StockError("Supplier is not archived.");
  await supplier.restore();
  return supplier;
}

/** Active supplier for a Stock In, or null when none was chosen. */
export async function supplierForDelivery(supplierId) {
  if (supplierId === undefined || supplierId === null || supplierId === "") return null;
  const supplier = await Supplier.findByPk(Number(supplierId), { raw: true });
  if (!supplier) throw new StockError("The selected supplier no longer exists or is archived.");
  return supplier;
}
