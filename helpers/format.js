// Shared server-side formatters. The client uses the same Intl options (public/js/analytics.js).
const peso = new Intl.NumberFormat("en-PH", { style: "currency", currency: "PHP" });
const int = new Intl.NumberFormat("en-PH");

// fmtMoney(1867.45) -> "₱1,867.45"
export const fmtMoney = value => peso.format(Number(value) || 0);

// Base units a product can be counted in. Stock is always stored in this unit; boxes are converted.
export const UNITS = ["piece", "tablet", "capsule", "bottle", "sachet", "vial", "ampule", "tube", "pack"];

// unitLabel("tablet", 3) -> "tablets", unitLabel("piece", 1) -> "pc"
export const unitLabel = (unit = "piece", n = 2) => {
  const one = Math.abs(Number(n)) === 1;
  if (!unit || unit === "piece") return one ? "pc" : "pcs";
  return one ? unit : `${unit}s`;
};

// fmtQty(1010, "tablet") -> "1,010 tablets"
export const fmtQty = (n, unit) => `${int.format(Number(n) || 0)} ${unitLabel(unit, n)}`;

// boxBreakdown(1010, 100) -> "10 boxes + 10"; "" when there is no box size or less than one box.
export const boxBreakdown = (pieces, piecesPerBox) => {
  const per = Number(piecesPerBox);
  const abs = Math.abs(Number(pieces) || 0);
  if (!Number.isInteger(per) || per < 2 || abs < per) return "";
  const boxes = Math.floor(abs / per), rest = abs % per;
  return `${int.format(boxes)} box${boxes === 1 ? "" : "es"}${rest ? ` + ${int.format(rest)}` : ""}`;
};

export const fmtInt = n => int.format(Number(n) || 0);
