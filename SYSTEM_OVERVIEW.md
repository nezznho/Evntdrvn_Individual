# PharmaCare — Pharmacy Inventory Management System

**System Overview Document**
Version 1.0 · November 2026

---

## 1. Executive Summary / Purpose

### 1.1 Mission

PharmaCare is a web-based inventory management system for small and medium pharmacies. It tracks every medicine from delivery to dispensing, down to the manufacturer **lot (batch) number** and **expiry date**.

Many pharmacies still rely on logbooks and spreadsheets. These records drift from the real shelf count, make expired stock easy to miss, and make it hard to trace a recalled lot. PharmaCare replaces them with one accurate, tamper-proof record of stock.

### 1.2 Value Proposition

| Problem in manual systems | How PharmaCare solves it |
| --- | --- |
| Counts drift from the real shelf stock | Quantities are calculated from lots and change only through logged movements |
| Expired medicine reaches patients | Expiry alerts (45 days ahead) and automatic First-Expiry, First-Out (FEFO) dispensing |
| Recalls are slow to trace | Every movement records the lot number, so one lot's full history is a single lookup |
| Records can be edited or erased | Stock logs are append-only; mistakes are reversed with a recorded VOID, never deleted |
| No clear accountability | Every movement records the staff member responsible and the time |

### 1.3 Target Users

| Role | Who they are | Main tasks |
| --- | --- | --- |
| **Admin** | Pharmacist-in-charge, owner or inventory manager | Manage products, staff, recalls, write-offs, corrections and the archive |
| **Staff** | Pharmacy assistants and counter staff | Receive deliveries, dispense medicine, check stock and expiry |

---

## 2. System Architecture & Tech Stack

### 2.1 Architecture

PharmaCare is a server-rendered web application. It uses a **Model-View-Controller (MVC)** structure on the **XianFire Framework** (Node.js and Express).

```
Browser (HTML/CSS/JS)
        │  HTTP (forms, JSON API)
        ▼
Express routes ──► Auth middleware (requireAuth / requireAdmin)
        │
        ▼
Controllers (authController, pharmaController)
        │
        ▼
Stock Service  ── the only place stock quantities change (DB transactions + row locks)
        │
        ▼
Sequelize models (User, Product, Batch, StockLog)
        │
        ▼
MySQL database + triggers that block edits/deletes of audit data
```

### 2.2 Technology Stack

| Layer | Technology | Purpose |
| --- | --- | --- |
| Frontend | Handlebars templates (`.xian`), CSS, Tailwind utilities, vanilla JavaScript | Page rendering, modals, keyboard shortcuts, command palette, barcode input |
| Backend | Node.js, Express 4 | Routing, request handling, role-based access |
| Business logic | `services/stockService.js` | All stock movements, run inside database transactions |
| Data access | Sequelize 6 (ORM) | Models, validation, soft deletes, schema sync |
| Database | MySQL (via `mysql2`) | Data storage plus integrity triggers |
| Security | `bcrypt`, `express-session`, `connect-flash` | Password hashing, login sessions, user messages |
| Dev tools | `nodemon`, XianFire CLI (`npm run migrate`, `route:list`) | Auto-reload, migrations, route listing |
| Hardware | Any USB barcode scanner (keyboard-emulation mode) | Fast product and lot lookup |

### 2.3 Data Model

| Table | Holds | Key rules |
| --- | --- | --- |
| **Users** | Name, email, hashed password, role (`admin` / `staff`) | Deactivated, never deleted (soft delete) |
| **Products** | Name, category, price, optional barcode, cached quantity and nearest expiry | Archived, never deleted; barcode unique |
| **Batches** | Lot number, manufacturer, quantity, expiry date, status (`active`, `expired`, `recalled`) | One row per product + lot number; cannot be deleted |
| **StockLogs** | Action, product, lot, signed amount, balance after, user, reason, reference | Append-only; cannot be updated or deleted |

**Integrity guarantees:**

- A product's quantity is always the sum of its **active** lots, recalculated in the same transaction as each movement.
- MySQL triggers stop anyone, even with direct SQL access, from editing or deleting stock logs or deleting products, lots or users.

---

## 3. Core Features Breakdown

### 3.1 Authentication & Role-Based Access Control

- **What it does:** Users sign in with email and password. Passwords are hashed with bcrypt, and sessions keep users signed in. New sign-ups through **Create an account** get the Staff role.
- **Access control:** Every page requires a login. Admin-only actions (product management, recalls, voids, staff, archive) are checked on the server, not just hidden in the interface.
- **Benefit:** Each person sees only what their job needs, and every action is tied to a real account.

### 3.2 Dashboard (Overview)

- **What it does:** Shows four key figures at a glance:
  - **Total inventory value** (quantity × price across active products)
  - **Low stock items** (25 units or fewer)
  - **Lots expiring or expired** (within 45 days)
  - **Stock activity** (recent movements and voids)
- It also lists the low-stock products and the lots expiring soonest, with days remaining.
- **Benefit:** Staff see what needs attention the moment they sign in.

### 3.3 Inventory Management

- **What it does:** Lists all active products with category, price, quantity on hand and nearest expiry. Users can search and filter by category.
- **Admins** can add, edit and archive products. Quantity and expiry **cannot be edited directly**; they change only through stock movements.
- **Benefit:** The catalog stays clean, and nobody can "fix" a count without leaving a record.

### 3.4 Batch / Lot Tracking

- **What it does:** Each delivery is recorded against a manufacturer lot number with its own quantity, expiry date and manufacturer. Each lot has a detail page with its full movement history.
- **Statuses:** `active` (sellable), `expired` (written off), `recalled` (quarantined).
- **Benefit:** Expiry is tracked per lot, not per product, and recalls can be traced exactly.

### 3.5 Stock In (Receiving)

- **What it does:** Staff record a delivery: product, lot number, expiry date, manufacturer, quantity and an optional delivery receipt or invoice number. The system creates the lot or tops up an existing one, then logs a `STOCK_IN` entry.
- **Benefit:** Every unit on the shelf can be traced to a delivery.

### 3.6 Dispensing (Stock Out with FEFO)

- **What it does:** Staff enter the quantity to dispense. The system takes stock from the lot that **expires first**, splitting across several lots if needed. A specific lot can also be chosen, for example by scanning it.
- **Safeguards:** Expired and recalled lots can never be dispensed, and stock can never go below zero.
- **Benefit:** Older stock leaves first, which cuts waste and protects patients.

### 3.7 Expiry Write-off & Recall (Admin)

- **Expire:** Removes a lot's remaining stock from sellable inventory and logs an `EXPIRED` entry. Writing off a lot before its expiry date requires a reason.
- **Recall:** Quarantines a lot (for example, after an FDA advisory) and logs a `RECALLED` entry with a required reason. The lot's history shows every unit already dispensed.
- **Benefit:** The pharmacy can respond to regulatory recalls in minutes, with proof.

### 3.8 Stock Logs — Immutable Audit Trail (Admin)

- **What it does:** Records every event: `PRODUCT_ADDED`, `PRODUCT_UPDATED`, `PRODUCT_ARCHIVED`, `PRODUCT_RESTORED`, `STOCK_IN`, `DISPENSED`, `EXPIRED`, `RECALLED` and `VOID`. Each entry stores who, when, how much, which lot, the balance after, and a reference number.
- **Corrections:** A wrong entry is reversed by an admin with a **VOID** and a required reason. The original stays visible and marked as voided, stock is restored to the original lot, and each entry can be voided only once.
- **Benefit:** A complete, trustworthy history for audits and inspections.

### 3.9 Staff Management (Admin)

- **What it does:** Admins add staff or admin accounts and deactivate them when they leave. Deactivated accounts can be restored.
- **Benefit:** Past log entries always point to a real person, even after they leave.

### 3.10 Archive (Admin)

- **What it does:** Lists archived products (with who archived them and why) and deactivated staff. Admins can restore them in one click.
- **Benefit:** Nothing is lost by mistake; "delete" is always reversible.

### 3.11 Barcode Scanning

- **What it does:** A USB barcode scanner works anywhere on the page. Scanning a product barcode opens that product; scanning a lot number in the dispense form picks that lot.
- **Benefit:** Faster, error-free entry at the counter.

### 3.12 Command Palette & Keyboard Shortcuts

- **What it does:** **Ctrl+K** opens a quick search for products, lots and pages. Keyboard shortcuts move between sections and run common actions; press **?** to see them all.
- **Benefit:** Experienced staff work faster without the mouse.

---

## 4. User Workflows / Journey

### 4.1 Primary Journey: From Delivery to Dispensing

1. **Sign in.** The user enters their email and password. The system checks the bcrypt hash and opens the dashboard for their role.
2. **Review the dashboard.** The user checks low-stock items and lots expiring within 45 days.
3. **Add a product (Admin, first time only).** The admin clicks **+ Add Product** and enters the name, category, price and optional barcode.
4. **Receive a delivery (Stock In).** Staff open the product, choose **Receive stock**, and enter the lot number, expiry date, manufacturer, quantity and receipt number. The lot quantity and product total update, and a `STOCK_IN` log is written.
5. **Dispense to a customer.** Staff scan or search the product, choose **Dispense** and enter the quantity. The system takes it from the earliest-expiring lot (FEFO) and writes a `DISPENSED` log with the remaining balance.
6. **Handle an expired lot (Admin).** When a lot shows up as expired, the admin opens it and clicks **Expire**. Its stock leaves the active total and an `EXPIRED` log is written.
7. **Correct a mistake (Admin).** If a quantity was entered wrongly, the admin opens **Stock logs**, picks the entry, and voids it with a reason. Stock returns to the original lot, and a `VOID` entry records who reversed it and why.
8. **Sign out.**

### 4.2 Recall Journey (Admin)

1. A recall notice names a lot number, for example `AMX24051`.
2. The admin searches the lot (Ctrl+K or **Batches / Lots**) and opens it.
3. The admin clicks **Recall** and enters the advisory number as the reason.
4. The lot is quarantined and can no longer be dispensed.
5. The lot's history lists every unit received and dispensed, with dates and staff, for reporting to the regulator.

---

## 5. Future Roadmap / Scalability

### 5.1 Possible Extensions

These are suggested next steps, not committed plans.

| Area | Extension |
| --- | --- |
| Account security | Working password reset by email (the Forgot Password page is currently a placeholder); admin approval for self-registered accounts |
| Purchasing | Suppliers, purchase orders and automatic reorder suggestions from low-stock levels |
| Sales | Point-of-sale receipts and prescription linking for regulated medicines |
| Reporting | Export of stock logs, expiry and recall reports to PDF or Excel; monthly consumption charts |
| Notifications | Email or SMS alerts for low stock, upcoming expiry and recalls |
| Multi-branch | Several pharmacy branches with stock transfers between them |
| Configuration | Admin-set thresholds for low stock (now 25 units) and expiry warning (now 45 days) |

### 5.2 Scalability Notes

- **Single source of truth:** All quantity changes go through the Stock Service in database transactions with row locks. This prevents race conditions when several staff work at the same time.
- **Indexed audit queries:** Stock logs are indexed by lot number and reference, so recall and audit lookups stay fast as the ledger grows.
- **Stateless pages:** The application server keeps only session data. Moving sessions to a shared store (such as Redis or MySQL) would allow several app servers behind a load balancer.
- **Configuration:** Database credentials are currently fixed in `models/db.js`. Before production, move them to environment variables and add HTTPS.
- **API-ready:** The existing JSON endpoints (`/api/search`, `/api/products/by-barcode/:code`) can grow into a full REST API for a mobile app or other integrations.

---

*Built on the XianFire Framework — Mindoro State University.*
