// Machine-to-machine auth for the POS device (routes/posApi.js).
// The POS sends   Authorization: Bearer <POS_API_KEY>   on every request - no browser session, no cookies.
// Every stock movement the POS causes is attributed to the service account in POS_SERVICE_USER_EMAIL,
// with the POS cashier's name added to the log entry.
import crypto from "crypto";
import { User } from "../models/userModel.js";

const digest = value => crypto.createHash("sha256").update(String(value)).digest();

export async function requirePosKey(req, res, next) {
  try {
    const expected = process.env.POS_API_KEY || "";
    if (expected.length < 32) {
      return res.status(503).json({ error: "POS API is disabled: set POS_API_KEY (at least 32 characters) in .env and restart." });
    }
    const match = /^Bearer\s+(.+)$/i.exec(req.get("authorization") || "");
    // Compare hashes so the check takes the same time whatever the key length (no timing leak).
    if (!match || !crypto.timingSafeEqual(digest(match[1].trim()), digest(expected))) {
      return res.status(401).json({ error: "Invalid or missing POS API key." });
    }

    const email = process.env.POS_SERVICE_USER_EMAIL;
    const account = email ? await User.findOne({ where: { email }, attributes: ["id", "name", "role"] }) : null;
    if (!account) {
      return res.status(503).json({ error: "POS API is not configured: POS_SERVICE_USER_EMAIL must be an active staff account." });
    }
    const cashier = String(req.body?.cashier || "").trim().slice(0, 100);
    req.posUser = { id: account.id, name: cashier ? `POS · ${cashier}` : `POS · ${account.name}` };
    req.posCashier = cashier || null;
    next();
  } catch (err) { next(err); }
}
