-- =====================================================================
-- PharmaCare: soft deletes, batch/lot tracking and immutable audit log
-- =====================================================================
-- REFERENCE ONLY. `npm run migrate` (migrate.js) builds this schema from the
-- Sequelize models and creates the triggers, so you do not need to run this file.
-- It documents what the database looks like for the capstone paper and defense.

-- 1. SOFT DELETES --------------------------------------------------------
-- Products: "Delete" in the UI sets deletedAt. Rows are never removed.
ALTER TABLE `Products`
  MODIFY `expiry` DATE NULL,                          -- now = nearest lot expiry (NULL when out of stock)
  ADD COLUMN `deletedById`  INT NULL,                 -- admin who archived it
  ADD COLUMN `deleteReason` VARCHAR(255) NULL,        -- required reason
  ADD COLUMN `deletedAt`    DATETIME NULL;            -- NULL = active, value = archived

-- Users: staff "delete" = deactivate. Logs keep pointing to a real person.
ALTER TABLE `Users`
  ADD COLUMN `deletedById` INT NULL,
  ADD COLUMN `deletedAt`   DATETIME NULL;

-- What the app runs when "Delete" is clicked (no DELETE FROM anywhere):
--   UPDATE `Products` SET `deletedById` = ?, `deleteReason` = ? WHERE `id` = ?;
--   UPDATE `Products` SET `deletedAt` = NOW() WHERE `id` = ? AND `deletedAt` IS NULL;
-- Active inventory query:  SELECT ... FROM `Products` WHERE `deletedAt` IS NULL;
-- Archive (admin) query:   SELECT ... FROM `Products` WHERE `deletedAt` IS NOT NULL;
-- Restore:                 UPDATE `Products` SET `deletedAt` = NULL WHERE `id` = ?;

-- 2. BATCH / LOT TRACKING ------------------------------------------------
CREATE TABLE IF NOT EXISTS `Batches` (
  `id`           INT AUTO_INCREMENT PRIMARY KEY,
  `productId`    INT NOT NULL,
  `batchNumber`  VARCHAR(50) NOT NULL,                -- manufacturer lot no., e.g. AMX24051
  `manufacturer` VARCHAR(255) NULL,
  `quantity`     INT NOT NULL DEFAULT 0,              -- on hand in this lot (never negative)
  `expiryDate`   DATE NOT NULL,
  `receivedAt`   DATETIME NOT NULL,
  `status`       ENUM('active','expired','recalled') NOT NULL DEFAULT 'active',
  `createdAt`    DATETIME NOT NULL,
  `updatedAt`    DATETIME NOT NULL,
  UNIQUE KEY `batches_product_lot_unique` (`productId`, `batchNumber`)
);
-- Products.quantity is a cached SUM(Batches.quantity WHERE status = 'active'),
-- recalculated in the same transaction as every movement.

-- 3. STOCK ACTIVITY LOG (append-only ledger) -----------------------------
-- Existing columns kept (action, product, amount, user) so old rows survive;
-- old free-text actions are converted to codes by migrate.js.
ALTER TABLE `StockLogs`
  MODIFY `action` VARCHAR(30) NOT NULL,   -- PRODUCT_ADDED | PRODUCT_UPDATED | PRODUCT_ARCHIVED | PRODUCT_RESTORED
                                          -- STOCK_IN | DISPENSED | EXPIRED | RECALLED | VOID
  ADD COLUMN `productId`    INT NULL,
  ADD COLUMN `batchId`      INT NULL,
  ADD COLUMN `batchNumber`  VARCHAR(50) NULL,         -- snapshot of the lot no.
  ADD COLUMN `balanceAfter` INT NULL,                 -- product on-hand after the movement
  ADD COLUMN `userId`       INT NULL,                 -- staff responsible (`user` holds the name snapshot)
  ADD COLUMN `reason`       VARCHAR(255) NULL,        -- required for VOID / recall / early write-off
  ADD COLUMN `reference`    VARCHAR(40) NULL,         -- DSP-..., RCV-..., or DR/invoice no.; groups one transaction
  ADD COLUMN `voidOfId`     INT NULL,                 -- VOID rows: id of the entry being reversed
  DROP COLUMN `updatedAt`,                            -- rows are never updated
  ADD UNIQUE KEY `stocklogs_void_of_unique` (`voidOfId`),  -- an entry can be voided only once
  ADD KEY `stocklogs_reference` (`reference`),
  ADD KEY `stocklogs_batch_number` (`batchNumber`);   -- fast recall lookups by lot

-- 4. DATABASE-LEVEL GUARDS -----------------------------------------------
-- Even direct SQL (phpMyAdmin, a buggy query) cannot destroy audit data.
CREATE TRIGGER `trg_stocklogs_no_update` BEFORE UPDATE ON `StockLogs` FOR EACH ROW
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Stock logs are immutable - record a VOID entry instead';
CREATE TRIGGER `trg_stocklogs_no_delete` BEFORE DELETE ON `StockLogs` FOR EACH ROW
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Stock logs cannot be deleted';
CREATE TRIGGER `trg_products_no_delete`  BEFORE DELETE ON `Products`  FOR EACH ROW
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Products cannot be deleted - archive them (soft delete)';
CREATE TRIGGER `trg_batches_no_delete`   BEFORE DELETE ON `Batches`   FOR EACH ROW
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Batches cannot be deleted - expire or recall them';
CREATE TRIGGER `trg_users_no_delete`     BEFORE DELETE ON `Users`     FOR EACH ROW
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Staff accounts cannot be deleted - deactivate them';

-- 5. PRODUCT BARCODES (USB scanner support) ------------------------------
-- Optional manufacturer barcode. Unique across all products (archived too) so a scan is never ambiguous.
ALTER TABLE `Products`
  ADD COLUMN `barcode` VARCHAR(64) NULL,
  ADD UNIQUE KEY `products_barcode_unique` (`barcode`);  -- many NULLs are allowed
-- Scanner lookup: SELECT id, name FROM Products WHERE barcode = ? AND deletedAt IS NULL;

-- 5b. PIECES AND BOXES -----------------------------------------------------
-- Stock is always stored in the product's base unit (piece, tablet, ...). Forms accept boxes too and
-- convert with piecesPerBox; the log keeps how it was entered (entryUnit/entryQty) next to the pieces.
ALTER TABLE `Products`
  ADD COLUMN `unit`         VARCHAR(20) NOT NULL DEFAULT 'piece',
  ADD COLUMN `piecesPerBox` INT NULL;                -- NULL = handled per piece only
ALTER TABLE `StockLogs`
  ADD COLUMN `entryUnit` VARCHAR(10) NULL,           -- 'box' when the quantity was entered in boxes
  ADD COLUMN `entryQty`  INT NULL;                   -- e.g. 10 (boxes); `amount` holds the pieces

-- 5c. LOW-STOCK LEVEL, CATEGORIES, SUPPLIERS, STOCK OUT -------------------
ALTER TABLE `Products`
  ADD COLUMN `reorderLevel` INT NOT NULL DEFAULT 25;  -- low-stock alert level in pieces, per product
CREATE TABLE IF NOT EXISTS `Categories` (            -- managed on the Categories page
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `name` VARCHAR(80) NOT NULL,                       -- Products.category holds this name (rename updates products)
  `description` VARCHAR(255) NULL,
  `createdAt` DATETIME NOT NULL, `updatedAt` DATETIME NOT NULL,
  UNIQUE KEY `categories_name_unique` (`name`)
);
CREATE TABLE IF NOT EXISTS `Suppliers` (             -- soft delete only (archived suppliers keep their deliveries)
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `name` VARCHAR(120) NOT NULL, `contactPerson` VARCHAR(120) NULL, `phone` VARCHAR(40) NULL,
  `email` VARCHAR(120) NULL, `address` VARCHAR(255) NULL,
  `createdAt` DATETIME NOT NULL, `updatedAt` DATETIME NOT NULL, `deletedAt` DATETIME NULL,
  UNIQUE KEY `suppliers_name_unique` (`name`)
);
ALTER TABLE `StockLogs`
  ADD COLUMN `supplierId` INT NULL,                  -- STOCK_IN: who delivered it; `reference` = delivery receipt no.
  ADD COLUMN `supplier`   VARCHAR(120) NULL;         -- supplier name snapshot
-- STOCK_OUT action: stock leaving without a sale (damaged, internal use, transfer...), reason required.
-- DISPENSED is now used only for sales pushed by the POS (routes/posApi.js).
-- Users.password holds bcrypt hashes only (models/userModel.js hashes on create/update; migrate.js converts old rows).

-- 6. USEFUL DEFENSE QUERIES ----------------------------------------------
-- Recall trace: every movement of a lot
--   SELECT createdAt, action, amount, user, reference, reason FROM StockLogs WHERE batchNumber = 'AMX24051' ORDER BY id;
-- All voids with who/why
--   SELECT v.createdAt, v.user, v.reason, o.action AS original, o.amount AS original_qty, o.user AS original_staff
--   FROM StockLogs v JOIN StockLogs o ON o.id = v.voidOfId ORDER BY v.id DESC;
-- Integrity check: cached quantity = lots = ledger
--   SELECT p.name, p.quantity,
--     (SELECT SUM(quantity) FROM Batches b WHERE b.productId = p.id AND b.status = 'active') AS lots,
--     (SELECT SUM(amount) FROM StockLogs l WHERE l.productId = p.id AND l.batchId IS NOT NULL) AS ledger
--   FROM Products p;

-- 7. SALES (written by services/saleService.js; analytics in services/analyticsService.js) -------
-- Every sale line reduces stock through stockService (FEFO + DISPENSED log). A line split across
-- two lots is stored as two rows. A sale line whose DISPENSED movement is VOIDed is excluded from analytics.
CREATE TABLE IF NOT EXISTS `Sales` (
  `id`         INT AUTO_INCREMENT PRIMARY KEY,
  `reference`  VARCHAR(40) NOT NULL,                  -- SALE-... receipt number
  `user_id`    INT NULL,
  `total`      DECIMAL(12,2) NOT NULL DEFAULT 0,
  `source`       VARCHAR(20) NULL,                    -- 'pos' = pushed by the POS API (routes/posApi.js)
  `external_ref` VARCHAR(64) NULL,                    -- POS receipt number; unique => POS retries never double-deduct
  `cashier`      VARCHAR(100) NULL,                   -- POS cashier name snapshot
  `created_at` DATETIME NOT NULL,
  UNIQUE KEY `sales_reference_unique` (`reference`),
  UNIQUE KEY `sales_external_ref_unique` (`external_ref`),
  KEY `sales_created_at` (`created_at`)
);
CREATE TABLE IF NOT EXISTS `SaleItems` (
  `id`         INT AUTO_INCREMENT PRIMARY KEY,
  `sale_id`    INT NOT NULL,
  `product_id` INT NOT NULL,
  `lot_id`     INT NULL,                              -- Batches.id the units came from
  `qty`        INT NOT NULL,
  `unit_price` DECIMAL(10,2) NOT NULL,
  `unit_cost`  DECIMAL(10,2) NULL,                    -- NULL = unknown, excluded from gross margin
  `user_id`    INT NULL,
  `stock_ref`  VARCHAR(40) NULL,                      -- StockLogs.reference of the DISPENSED lines
  `created_at` DATETIME NOT NULL,
  KEY `sale_items_sale` (`sale_id`),
  KEY `sale_items_product_created` (`product_id`, `created_at`),
  KEY `sale_items_created_at` (`created_at`)
);
