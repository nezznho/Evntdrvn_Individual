import { Product } from "../models/productModel.js";
import { StockLog } from "../models/stockLogModel.js";
import { User } from "../models/userModel.js";

const requireUser = (req, res) => { if (!req.session.user) { res.redirect("/login"); return null; } return req.session.user; };
const isAdmin = req => req.session.user?.role === "admin";
const addLog = (action, product, amount, user) => StockLog.create({ action, product, amount, user: user.name });

export const dashboard = async (req, res) => {
  const user = req.session.user || { id: null, name: "Guest", role: "guest" };
  const products = await Product.findAll({ order: [["name", "ASC"]], raw: true });
  const users = await User.findAll({ attributes: ["id", "name", "email", "role"], raw: true });
  const logs = await StockLog.findAll({ order: [["createdAt", "DESC"]], limit: 20, raw: true });
  const today = new Date(); products.forEach(p => p.price = Number(p.price));
  const expiring = products.filter(p => { const expiry = new Date(`${p.expiry}T00:00:00`); return expiry >= today && (expiry - today) / 86400000 <= 45; });
  const low = products.filter(p => p.quantity <= 25);
  const value = products.reduce((sum, p) => sum + p.quantity * p.price, 0);
  res.render("dashboard", { title: "Pharma Dashboard", user, isAdmin: user.role === "admin", inventory: products, users, logs, expiring, low, value: value.toFixed(2), total: products.length, lowCount: low.length, expiringCount: expiring.length });
};
export const addProduct = async (req, res) => {
  const user = requireUser(req, res); if (!user) return; if (!isAdmin(req)) return res.status(403).send("Admin access required");
  const { name, category, quantity, expiry, price } = req.body;
  await Product.create({ name, category, quantity: Number(quantity), expiry, price: Number(price) }); await addLog("Product added", name, Number(quantity), user);
  res.redirect("/dashboard#inventory");
};
export const editProduct = async (req, res) => {
  const user = requireUser(req, res); if (!user) return; if (!isAdmin(req)) return res.status(403).send("Admin access required");
  const product = await Product.findByPk(req.params.id); if (!product) return res.status(404).send("Product not found");
  await product.update({ name: req.body.name, category: req.body.category, quantity: Number(req.body.quantity), expiry: req.body.expiry, price: Number(req.body.price) });
  await addLog("Product updated", product.name, Number(req.body.quantity), user); res.redirect("/dashboard#inventory");
};
export const deleteProduct = async (req, res) => {
  const user = requireUser(req, res); if (!user) return; if (!isAdmin(req)) return res.status(403).send("Admin access required");
  const product = await Product.findByPk(req.params.id); if (!product) return res.status(404).send("Product not found");
  await addLog("Product deleted", product.name, 0, user); await product.destroy(); res.redirect("/dashboard#inventory");
};
export const updateStock = async (req, res) => {
  const user = requireUser(req, res); if (!user) return; const product = await Product.findByPk(req.params.id); if (!product) return res.status(404).send("Product not found");
  const amount = Number(req.body.quantity); await product.update({ quantity: Math.max(0, product.quantity + amount) }); await addLog(amount > 0 ? "Stock received" : "Stock adjustment", product.name, amount, user); res.redirect("/dashboard#inventory");
};
export const dispense = async (req, res) => {
  const user = requireUser(req, res); if (!user) return; const product = await Product.findByPk(req.params.id); if (!product) return res.status(404).send("Product not found");
  const amount = Number(req.body.quantity); if (amount <= 0 || amount > product.quantity) return res.status(400).send("Invalid dispense quantity");
  await product.update({ quantity: product.quantity - amount }); await addLog("Dispensed", product.name, -amount, user); res.redirect("/dashboard#inventory");
};
export const addUser = async (req, res) => {
  const user = requireUser(req, res); if (!user) return; if (!isAdmin(req)) return res.status(403).send("Admin access required");
  const { name, email, password, role } = req.body; await User.create({ name, email, password: password || "staff123", role }); res.redirect("/dashboard#staff");
};
export const deleteUser = async (req, res) => {
  const user = requireUser(req, res); if (!user) return; if (!isAdmin(req)) return res.status(403).send("Admin access required");
  await User.destroy({ where: { id: req.params.id } }); res.redirect("/dashboard#staff");
};
