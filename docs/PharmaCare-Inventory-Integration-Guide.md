# PharmaCare Inventory: Integration Guide

For the POS, Kiosk and Audit Trail teams. Read this before changing your system, and give it to your AI assistant with your prompts.

_Version 1.0 · November 22, 2026 · Owner: Inventory team_

## 1. How to use this document

Four systems will run on different devices and work as one pharmacy system: POS (PharmaCore), Inventory (PharmaCare, this system), Kiosk and Audit Trail. This guide says which system owns which data, what the Inventory system already does, and the exact API the other systems must use. Following it avoids two systems keeping the same data in two places, which is the main cause of numbers that do not match.

- When you ask an AI assistant to change your system, paste section 9 (Prompt snippet) into the prompt and attach this whole file.
- Rules marked MUST are agreed for all four systems. If one does not fit your system, raise it with the Inventory team first instead of working around it.
- Items marked PLANNED are not built yet in the Inventory system. Do not depend on them until the Inventory team confirms they are live.

## 2. Who owns what (single source of truth)

Each kind of data has exactly one owner. Only the owner stores and changes it. Every other system reads it from the owner through its API and never keeps its own editable copy.

| Data | Owner | Other systems |
| --- | --- | --- |
| Medicines / products: name, barcode, category, price per piece, unit, pieces per box, low-stock level | Inventory | Read through the Inventory API. Do not create or edit products. |
| Stock quantities, lots (batch numbers), expiry dates | Inventory | Read only. Stock changes only through Inventory actions or POS sales/voids sent to the Inventory API. |
| Deliveries (stock in), suppliers, delivery receipt numbers | Inventory | Do not keep a suppliers list or receive stock anywhere else. |
| Stock out (damaged, internal use, transfer…), expiry write-offs, recalls | Inventory | Not done in POS or Kiosk. |
| Categories | Inventory | Read the category name from the product. |
| Sales, payments, receipts, discounts, tax, customers, cashier shifts | POS | Inventory only receives the items sold (to deduct stock). Kiosk sends orders to the POS. |
| Prescription verification at checkout | POS | Inventory does not check prescriptions. |
| Customer self-service screens and kiosk orders before payment | Kiosk | A kiosk order becomes a sale only when the POS completes it. |
| Audit history across all systems (who did what, when) | Audit Trail | Each system sends events to the Audit Trail and keeps its own local log too. |
| User accounts | Each system | Accounts are not shared yet. Send the user's display name in API calls (for example the cashier name). |

## 3. Do not duplicate

#### POS (PharmaCore) MUST NOT

- keep its own stock count as the real number. Show the Inventory's sellable stock and check it at checkout.
- have stock adjustments, opening stock, receive stock, lots, expiry write-offs, suppliers or categories screens while it is connected to the Inventory. These are already blocked in PharmaCore when INVENTORY_URL is set.
- add new medicines with stock. A medicine on the POS must have the same code as a product barcode in the Inventory.
- show inventory reports (stock value, expiring lots, low stock). Link to the Inventory instead.

#### Kiosk MUST NOT

- deduct stock or record sales itself. It reads products from the Inventory and sends orders to the POS.
- keep its own product list or prices. Read them from the Inventory API (cache for a short time is fine).

#### Audit Trail MUST NOT

- store business data that other systems own (stock, prices, sales totals) as editable records. It stores events only, and events are never edited or deleted.
- call into other systems' databases. Systems push events to it.

#### Inventory (this system) does not

- sell. There is no checkout and no sales screens. Sales reports are the POS's job.
- handle payments, customers or receipts.

## 4. What the Inventory system already does

Built with Node.js, Express (XianFire), Handlebars views, Sequelize and MySQL. Runs on port 3002. Roles: admin and staff.

| Feature | Details |
| --- | --- |
| Products | Name, category, barcode (unique, also archived products), price per piece, base unit (piece, tablet, capsule, bottle, sachet, vial, ampule, tube, pack), pieces per box, low-stock alert level per product. Separate Add product page; Edit dialog. Archive (soft delete) and restore. |
| Pieces and boxes | Stock is always stored in pieces. Forms and the API accept boxes and convert with pieces per box. The log keeps how it was entered (for example "10 boxes"). |
| Lots / batches | Every unit belongs to a lot with a batch number and expiry date. Selling and stock out take the earliest expiry first (FEFO). Expired lots are not sellable. Lot page shows the full movement history (stock card). |
| Stock in (deliveries) | Lot number, expiry, quantity in pieces or boxes, manufacturer, supplier, delivery receipt / invoice number, notes. Shows stock before and after. |
| Stock out | For stock leaving without a sale. Reason required: damaged, internal use, transfer to another branch, returned to supplier, free sample, other (with details). |
| Expire / recall a lot | Write off a whole lot as expired, or recall and quarantine it. |
| Void | A mistake is reversed with a VOID entry from the lot page; the original stays and is marked VOIDED. POS sales cannot be voided in the Inventory; they are voided from the POS (F2). |
| Stock logs | Append-only, read-only audit log: action, product, lot, quantity (with units), stock before → after with growth %, staff, reference, supplier, reason. Database triggers block edits and deletes. |
| Categories | Admin page: add, rename (renames it on its products), delete only when unused. |
| Suppliers | Admin page: name, contact person, phone, email, address; delivery count and last delivery. Archive and restore. |
| Dashboard | Inventory only (no sales): inventory value, low stock, expiring lots, stock in/out chart, value by category, days of stock left, slow movers, expiry risk. |
| Staff and security | Admin and staff roles, passwords stored as bcrypt hashes (at least 8 characters), deactivate and reactivate accounts, archive page. |
| Keyboard and scanner | Command palette, shortcuts for every page, USB barcode scanner support. |
| POS API | Key-protected JSON API used by the POS (section 6). Already connected and tested with PharmaCore. |

## 5. Shared conventions (all four systems)

| Topic | Rule (MUST) |
| --- | --- |
| Product identity | The Inventory barcode is the product code everywhere. POS medicine code = Inventory barcode = Kiosk product code. |
| Quantities | Whole numbers in pieces (the product's base unit). To sell or order by the box, send unit: "box"; the Inventory converts it with piecesPerBox. |
| Money | Numbers with 2 decimals, in pesos. Inventory prices are per piece; a box price is price × piecesPerBox. |
| Dates and times | ISO 8601, for example 2026-11-21T13:18:21Z. Expiry dates as YYYY-MM-DD. |
| API paths | /api/<system>/v1/... (for example /api/pos/v1, /api/audit/v1). Breaking changes get a new version (v2). |
| System-to-system login | Header Authorization: Bearer <API key>. Each calling system has its own key, stored in .env, never in code or git. |
| Errors | JSON { "error": "readable message" } with 400 bad input, 401 bad key, 404 not found, 409 business rule (for example not enough stock), 503 not configured or not reachable. |
| Retries | Every request that changes data carries a unique reference (receipt number, order number, event id). Sending it again must not apply it twice. |
| Health check | Every system exposes GET /api/<system>/v1/health returning { ok: true }. |
| Timeouts | Calls between systems time out after about 8 seconds and show a clear message; they never hang the screen. |
| Addresses | Other systems' URLs and keys come from .env (for example INVENTORY_URL, INVENTORY_API_KEY, AUDIT_URL), never hard-coded. |

## 6. Inventory API reference (live)

Base URL: http://192.168.1.16:3002/api/pos/v1. Every request needs Authorization: Bearer <POS_API_KEY>. The key is in the Inventory's .env file; ask the Inventory team for it.

| Method | Path | What it does |
| --- | --- | --- |
| GET | /health | Connection check: { ok, system, time }. |
| GET | /products?q=&codes=A,B&updatedSince= | Products with live stock. q searches name or barcode; codes = exact barcodes (up to 500); updatedSince = ISO time. |
| GET | /products/barcode/:code | One product by barcode (404 if unknown). |
| GET | /products/:id | One product with its sellable lots. |
| POST | /sales | Record a completed POS sale. Deducts stock by lot (earliest expiry first). Safe to repeat with the same reference. |
| GET | /sales/:reference | A recorded sale, with lot numbers and whether it was voided. |
| POST | /sales/:reference/void | Return a sale's units to their lots. Safe to repeat. 404 if the Inventory never received that sale. |

#### Product (response of GET /products)

```jsonc
{
  "id": 17, "barcode": "BFL-T1", "name": "Bioflu", "category": "Respiratory",
  "price": 8.5,            // per piece
  "unit": "tablet", "piecesPerBox": 100, "reorderLevel": 200,
  "sellable": 1050,        // unexpired pieces: the number to sell from
  "onHand": 1050,          // all pieces in active lots (may include expired lots)
  "nearestExpiry": "2028-01-31",
  "updatedAt": "2026-11-21T13:17:59.000Z"
}
```

#### Record a sale: POST /sales

```jsonc
// request
{
  "reference": "PC-534A5BFD3973",      // POS receipt number, unique, 3-64 characters
  "cashier": "Ana",
  "items": [
    { "barcode": "BFL-T1", "qty": 1, "unit": "box", "unitPrice": 850 },  // box price
    { "barcode": "PCM-500", "qty": 3, "unitPrice": 4.25 }                // per piece (default)
  ]
}
// 201 created, or 200 with "duplicate": true if this reference was already recorded
{
  "duplicate": false,
  "sale": {
    "reference": "PC-534A5BFD3973", "inventoryReference": "SALE-MWQFOGS4980",
    "total": 862.75, "voided": false, "cashier": "Ana",
    "lines": [                                       // always in pieces, one line per lot
      { "barcode": "BFL-T1", "lotNumber": "BFL001", "lotExpiry": "2028-01-31",
        "productId": 17, "lotId": 4, "quantity": 100, "unitPrice": 8.5 },
      { "barcode": "PCM-500", "lotNumber": "PCM2503A", "lotExpiry": "2027-06-30",
        "productId": 3, "lotId": 7, "quantity": 3, "unitPrice": 4.25 }
    ]
  }
}
// 409 { "error": "Only 95 pcs of Paracetamol 500mg available (unexpired)." }
```

#### Void a sale: POST /sales/:reference/void

```jsonc
// request
{ "reason": "Customer returned item", "approvedBy": "Owner name", "cashier": "Ana" }
// response
{ "reference": "PC-534A5BFD3973", "alreadyVoided": false, "linesReversed": 1 }
```

#### Rules the POS already follows (copy them in the Kiosk and Audit Trail)

1. Check stock with the live sellable number, then send the sale to the Inventory before saving it locally. If the Inventory refuses (409) or cannot be reached, the sale is not completed.
2. Use the same reference when a request is retried, so it is never applied twice.
3. If the local save fails after the Inventory accepted the sale, void it in the Inventory so both agree.
4. Voids go POS → Inventory first; if the Inventory fails, nothing changes locally.

## 7. What each team should build

### POS (PharmaCore): connected

- Done: live stock in search, price check and product grid; sales and voids sent to the Inventory; lot numbers on receipts; local stock changes blocked while connected.
- To do: let the cashier choose piece or box in the cart and send unit: "box" (use piecesPerBox from the product).
- To do: take the price per piece from the Inventory product instead of keeping a separate POS price, or agree with the Inventory team which one wins.
- Keep on the POS only POS-specific fields keyed by the product code, such as "prescription required".
- Send audit events (section 8) for sales, voids, logins and settings changes.

### Kiosk

- Read products from the Inventory (GET /products, /products/barcode/:code). Show only products with sellable > 0. Show price per piece and per box.
- Send the customer's order to the POS as a pending order (the POS team defines this endpoint, for example POST /api/pos-orders/v1/orders). The POS completes and charges it, and only then is stock deducted.
- PLANNED: the Inventory will give the Kiosk its own read-only key. Until then, ask the Inventory team before using the POS key.

### Audit Trail

- Provide POST /api/audit/v1/events (Bearer key per system) that stores events append-only and ignores an eventId it already has.
- Provide GET /api/audit/v1/health and a read-only screen to search events by system, user, action, date and reference.
- PLANNED: the Inventory will send events for product added/edited/archived, stock in, stock out, expire, recall, void, POS sales received, and staff changes.

## 8. Audit event format

```jsonc
{
  "eventId": "inventory-48213",          // unique per system: "<system>-<local log id>"
  "system": "inventory",                 // pos | inventory | kiosk | audit
  "action": "STOCK_IN",                  // the system's own action code
  "actor": "zen",                        // display name of the user (or "POS · Ana")
  "entity": "product", "entityId": "17",
  "reference": "DR-10234",               // receipt, delivery or order number
  "summary": "Bioflu: 10 → 1,010 tablets (+1,000) from Unilab Distribution",
  "details": { "lot": "BFL001", "quantity": 1000, "unit": "tablet" },
  "occurredAt": "2026-11-21T13:18:21Z"
}
```

Use an outbox so a down Audit Trail never blocks selling or receiving: write the event to a local outbox table in the same database transaction as the action, and let a background job send unsent events every few seconds, retrying until the Audit Trail answers. Because eventId is unique, sending an event twice is harmless.

## 9. Prompt snippet for your AI assistant

Paste this at the start of your prompt and attach this file:

```text
Our pharmacy has four systems on separate devices: POS (PharmaCore), Inventory (PharmaCare),
Kiosk and Audit Trail. I am working on the <POS | Kiosk | Audit Trail>. Follow the attached
"PharmaCare Inventory: Integration Guide" exactly:
- The Inventory owns products, prices per piece, units/pieces per box, stock, lots, expiry,
  suppliers, categories, stock in/out. Do not create tables, screens or logic for these in my
  system; read them from the Inventory API at INVENTORY_URL with INVENTORY_API_KEY.
- The POS owns sales, payments, receipts and customers. The Kiosk only reads products and sends
  orders to the POS. The Audit Trail only stores events.
- Product code = Inventory barcode. Quantities are whole pieces; boxes are sent as unit "box".
- Use /api/<system>/v1 paths, Bearer API keys from .env, JSON errors { "error": "..." },
  a unique reference on every request that changes data, ISO 8601 times, an 8-second timeout,
  and GET /health.
- Do not change the Inventory API. If something is missing, list it as a request for the
  Inventory team instead of building a copy.
```

## 10. Devices and settings

| System | Address | Settings it needs (.env) |
| --- | --- | --- |
| Inventory | http://192.168.1.16:3002 | POS_API_KEY, POS_SERVICE_USER_EMAIL (already set) |
| POS | http://<POS device IP>:3001 | INVENTORY_URL, INVENTORY_API_KEY, later AUDIT_URL, AUDIT_API_KEY |
| Kiosk | http://<Kiosk device IP>:3004 | INVENTORY_URL, INVENTORY_API_KEY (read-only, planned), POS_URL, POS_ORDER_KEY |
| Audit Trail | http://<Audit device IP>:3003 | One API key per sending system |

- Reserve each device's IP in the router so it never changes, and keep the devices on the same network.
- Open each system's port in the Windows Firewall only for the devices that call it.
- Never put API keys or .env files in git, screenshots or chat.

> Questions or missing API features: ask the Inventory team. Do not copy Inventory data into another system to work around a missing endpoint.
