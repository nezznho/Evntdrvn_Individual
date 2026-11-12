
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
    
import express from "express";
import { homePage } from "../controllers/homeController.js";
const router = express.Router();
// Express 4 does not catch errors from async handlers; this forwards them to the error handler
// in index.js instead of crashing the whole server.
const safe = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
router.get("/", (req, res) => res.redirect("/dashboard"));

import { loginPage, registerPage, forgotPasswordPage, loginUser, registerUser, logoutUser, requireAuth, requireAdmin } from "../controllers/authController.js";

router.get("/login", loginPage);
router.post("/login", safe(loginUser));
router.get("/register", registerPage);
router.post("/register", safe(registerUser));
router.get("/forgot-password", forgotPasswordPage);
router.get("/logout", logoutUser);

import {
  dashboard, batchDetail, archivePage,
  addProduct, editProduct, deleteProduct, restoreProduct,
  updateStock, dispense, expireBatch, recallBatch, voidLog,
  addUser, deleteUser, restoreUser,
  searchApi, productByBarcode
} from "../controllers/pharmaController.js";

// Any signed-in user (staff or admin)
router.get("/dashboard", requireAuth, safe(dashboard));
router.get("/batches/:id", requireAuth, safe(batchDetail));
router.post("/products/:id/stock", requireAuth, updateStock);       // Stock In (delivery into a lot)
router.post("/products/:id/dispense", requireAuth, dispense);       // Stock Out (FEFO)
// JSON API for the command palette and barcode scanner (public/js/keyboard.js)
router.get("/api/search", requireAuth, safe(searchApi));
router.get("/api/products/by-barcode/:code", requireAuth, safe(productByBarcode));

// Admin only
router.post("/products", requireAuth, requireAdmin, addProduct);
router.post("/products/:id/edit", requireAuth, requireAdmin, editProduct);
router.post("/products/:id/delete", requireAuth, requireAdmin, deleteProduct);   // SOFT delete (archive)
router.post("/products/:id/restore", requireAuth, requireAdmin, restoreProduct);
router.post("/batches/:id/expire", requireAuth, requireAdmin, expireBatch);
router.post("/batches/:id/recall", requireAuth, requireAdmin, recallBatch);
router.post("/logs/:id/void", requireAuth, requireAdmin, voidLog);
router.post("/staff", requireAuth, requireAdmin, addUser);
router.post("/staff/:id/delete", requireAuth, requireAdmin, deleteUser);         // SOFT delete (deactivate)
router.post("/staff/:id/restore", requireAuth, requireAdmin, restoreUser);
router.get("/admin/archive", requireAuth, requireAdmin, safe(archivePage));

export default router;
