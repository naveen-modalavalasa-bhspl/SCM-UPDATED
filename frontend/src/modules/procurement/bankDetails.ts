/**
 * A supplier's bank details and GST state, checked as they are typed (2026-11-23) —
 * the screen half of `suppliers.bank_problems`, pure so it is tested. The server is
 * still the one that refuses; this only says the same thing before the press.
 */
export const cleanIfsc = (v?: string | null) => (v ?? "").replace(/\s+/g, "").toUpperCase();
export const cleanAccount = (v?: string | null) => (v ?? "").replace(/[\s-]+/g, "");

const IFSC_RE = /^[A-Z]{4}0[A-Z0-9]{6}$/;
const ACCOUNT_RE = /^\d{9,18}$/;

export function ifscProblem(v?: string | null): string | null {
  const code = cleanIfsc(v);
  if (!code) return "Required.";
  if (!IFSC_RE.test(code)) return "11 characters: 4 letters, a 0, then 6 letters or digits (e.g. SBIN0001234).";
  return null;
}

export function accountProblem(v?: string | null): string | null {
  const account = cleanAccount(v);
  if (!account) return "Required.";
  if (!/^\d+$/.test(account)) return "Digits only.";
  if (!ACCOUNT_RE.test(account)) return "9 to 18 digits.";
  return null;
}

/** The two account boxes must agree — one wrong digit pays somebody else. */
export function confirmProblem(account?: string | null, confirm?: string | null): string | null {
  if (!cleanAccount(confirm)) return "Type the account number again.";
  return cleanAccount(account) === cleanAccount(confirm) ? null : "Does not match the account number.";
}

/** The bank a code belongs to, from its first four letters — enough to catch a typo. */
const BANKS: Record<string, string> = {
  SBIN: "State Bank of India", HDFC: "HDFC Bank", ICIC: "ICICI Bank", UTIB: "Axis Bank",
  KKBK: "Kotak Mahindra Bank", PUNB: "Punjab National Bank", BARB: "Bank of Baroda",
  CNRB: "Canara Bank", UBIN: "Union Bank of India", IDIB: "Indian Bank", IOBA: "Indian Overseas Bank",
  BKID: "Bank of India", MAHB: "Bank of Maharashtra", CBIN: "Central Bank of India",
  UCBA: "UCO Bank", PSIB: "Punjab & Sind Bank", YESB: "Yes Bank", INDB: "IndusInd Bank",
  IDFB: "IDFC First Bank", FDRL: "Federal Bank", KARB: "Karnataka Bank", KVBL: "Karur Vysya Bank",
  SIBL: "South Indian Bank", TMBL: "Tamilnad Mercantile Bank", CIUB: "City Union Bank",
  RATN: "RBL Bank", APGB: "Andhra Pragathi Grameena Bank", APGV: "Andhra Pradesh Grameena Vikas Bank",
};
export const bankFromIfsc = (v?: string | null) => BANKS[cleanIfsc(v).slice(0, 4)] ?? null;

/** Masked for anywhere but the form: `••••••4321`. */
export function maskAccount(v?: string | null): string {
  const account = cleanAccount(v);
  return account ? "•".repeat(Math.max(account.length - 4, 2)) + account.slice(-4) : "";
}

/** The first two digits of a GSTIN — its state code — or null. */
export function gstStateCode(gstin?: string | null): string | null {
  const g = (gstin ?? "").trim();
  return /^\d{2}/.test(g) && g.length >= 2 ? g.slice(0, 2) : null;
}

/** What the "same state" switch starts as: their GSTIN's state against ours. No GSTIN
 *  on either side is IGST (false), the rule taxes have always followed. */
export function sameStateFromGstin(ourStateCode: string | null | undefined, theirGstin?: string | null): boolean {
  const theirs = gstStateCode(theirGstin);
  return !!ourStateCode && !!theirs && ourStateCode === theirs;
}
