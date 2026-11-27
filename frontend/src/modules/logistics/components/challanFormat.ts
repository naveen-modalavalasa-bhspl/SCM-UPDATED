/**
 * How the Delivery Challan WRITES its numbers — pure, so the sheet only draws.
 *
 * Money is rupees at two decimals in Indian grouping (1,23,456.00); a quantity drops
 * trailing zeros (12, 2.5 — never 12.000); weight and volume carry their unit and
 * say nothing at all when unmeasured, because "0 kg" on a challan reads as a load
 * that weighs nothing. The total is also written in words, the way a challan book
 * carries it: "Rupees One Lakh Twenty Three Thousand and Paise Fifty Only".
 */
const num = (value: unknown): number | null => {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

export function money(value: unknown): string {
  const n = num(value) ?? 0;
  return n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function qty(value: unknown): string {
  const n = num(value) ?? 0;
  return n.toLocaleString("en-IN", { maximumFractionDigits: 3 });
}

export function weight(value: unknown): string | null {
  const n = num(value);
  return n && n > 0 ? `${n.toLocaleString("en-IN", { maximumFractionDigits: 2 })} kg` : null;
}

export function volume(value: unknown): string | null {
  const n = num(value);
  return n && n > 0 ? `${n.toLocaleString("en-IN", { maximumFractionDigits: 3 })} m³` : null;
}

export function dimensions(sides?: (string | number | null)[] | null): string | null {
  if (!sides || sides.length !== 3 || sides.some((s) => !num(s))) return null;
  return `${sides.map((s) => num(s)!.toLocaleString("en-IN", { maximumFractionDigits: 1 })).join(" × ")} cm`;
}

const ONES = [
  "", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten",
  "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen",
  "Eighteen", "Nineteen",
];
const TENS = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];

function belowHundred(n: number): string {
  if (n < 20) return ONES[n];
  return `${TENS[Math.floor(n / 10)]}${n % 10 ? ` ${ONES[n % 10]}` : ""}`;
}

function belowThousand(n: number): string {
  const hundreds = Math.floor(n / 100);
  const rest = n % 100;
  return [hundreds ? `${ONES[hundreds]} Hundred` : "", rest ? belowHundred(rest) : ""]
    .filter(Boolean).join(" ");
}

/** A whole number in the Indian system: crore, lakh, thousand, hundred. */
export function indianWords(whole: number): string {
  if (whole === 0) return "Zero";
  const parts: string[] = [];
  const crore = Math.floor(whole / 10_000_000);
  let rest = whole % 10_000_000;
  if (crore) parts.push(`${indianWords(crore)} Crore`);
  const lakh = Math.floor(rest / 100_000);
  rest %= 100_000;
  if (lakh) parts.push(`${belowHundred(lakh)} Lakh`);
  const thousand = Math.floor(rest / 1000);
  rest %= 1000;
  if (thousand) parts.push(`${belowHundred(thousand)} Thousand`);
  if (rest) parts.push(belowThousand(rest));
  return parts.join(" ");
}

export function rupeesInWords(value: unknown): string {
  const n = Math.max(0, num(value) ?? 0);
  const paise = Math.round(n * 100) % 100;
  const rupees = Math.floor(Math.round(n * 100) / 100);
  return `Rupees ${indianWords(rupees)}${paise ? ` and Paise ${belowHundred(paise)}` : ""} Only`;
}
