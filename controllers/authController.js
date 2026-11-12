
      /*
    MIT License
    
    Copyright (c) 2025 Christian I. Cabrera || XianFire Framework
    Mindoro State University - Philippines

    Permission is hereby granted, free of charge, to any person obtaining a copy
    of this software and associated documentation files (the "Software"), to deal
    in the Software without restriction, including without limitation the rights
    to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
    copies of the Software, and to permit persons to whom the Software is
    furnished to do so, subject to the following conditions:

    The above copyright notice and this permission notice shall be included in all
    copies or substantial portions of the Software.

    THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
    IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
    FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
    AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
    LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
    OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
    SOFTWARE.
    */
    
import { User } from "../models/userModel.js";

export const loginPage = (req, res) => res.render("login", { title: "Login", layout: false });
export const registerPage = (req, res) => res.render("register", { title: "Register", layout: false });
export const forgotPasswordPage = (req, res) => res.render("forgotpassword", { title: "Forgot Password", layout: false });
export const dashboardPage = (req, res) => res.redirect("/dashboard");

export const loginUser = async (req, res) => {
  const { email, password } = req.body;
  // paranoid: false so a deactivated account gets a clear message instead of "invalid password".
  const user = await User.findOne({ where: { email }, paranoid: false });
  if (!user || user.password !== password) return res.render("login", { title: "Login", layout: false, error: "Invalid email or password." });
  if (user.deletedAt) return res.render("login", { title: "Login", layout: false, error: "This account has been deactivated. Please contact the administrator." });
  req.session.user = { id: user.id, name: user.name, email: user.email, role: user.role };
  res.redirect("/dashboard");
};

export const registerUser = async (req, res) => {
  const { name, email, password } = req.body;
  const existing = await User.findOne({ where: { email }, paranoid: false }); // includes deactivated accounts
  if (existing) return res.render("register", { title: "Register", layout: false, error: "That email is already registered." });
  const user = await User.create({ name, email, password, role: "staff" });
  req.session.user = { id: user.id, name, email, role: "staff" }; res.redirect("/dashboard");
};

export const logoutUser = (req, res) => req.session.destroy(() => res.redirect("/login"));

// Route guards. Re-reading the user on each request means a deactivated account is signed out immediately.
// JSON endpoints (/api/...) get a 401 instead of a redirect so fetch() callers can react to it.
export const requireAuth = async (req, res, next) => {
  const deny = () => req.originalUrl.startsWith("/api/")
    ? res.status(401).json({ error: "Your session has ended. Please sign in again." })
    : res.redirect("/login");
  try {
    if (!req.session.user) return deny();
    const user = await User.findByPk(req.session.user.id, { attributes: ["id", "name", "email", "role"] });
    if (!user) return req.session.destroy(() => deny());
    req.user = user.get({ plain: true });
    req.session.user = req.user;
    next();
  } catch (err) { next(err); }
};

export const requireAdmin = (req, res, next) =>
  req.user?.role === "admin" ? next() : res.status(403).send("Admin access required");
