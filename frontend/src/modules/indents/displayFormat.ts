/**
 * Master data sometimes exposes UOM codes as `uom-ml` instead of the short code
 * users expect to read. Keep the API value untouched and normalise only the text
 * rendered by the indents frontend.
 */
export function displayUom(value?: string | null) {
  const text = value?.trim() ?? "";
  return text.replace(/^uom[-_\s]+/i, "").trim();
}

const PENDING_APPROVAL_ROLE_LABELS: Record<string, string> = {
  "district manager": "DM",
  "regional manager": "RM",
};

export function compactPendingApprovalText(value?: string | null) {
  let text = value?.trim().replace(/\s+/g, " ") ?? "";
  for (const [role, label] of Object.entries(PENDING_APPROVAL_ROLE_LABELS)) {
    text = text.replace(new RegExp(`\\b${role}\\b`, "gi"), label);
  }
  return text;
}

export function pendingApprovalLabel(currentApproverName?: string | null) {
  const value = currentApproverName?.trim().replace(/\s+/g, " ");
  if (!value) return "Pending Approval";
  const role = value.match(/\(([^)]+)\)\s*[.:;]?\s*$/)?.[1]?.trim();
  return `Pending at ${compactPendingApprovalText(role || value)}`;
}

export function pendingApprovalTargetFromMessage(message?: string | null) {
  const value = message?.trim().replace(/\s+/g, " ");
  if (!value) return null;
  const role = value.match(/\(([^)]+)\)\s*[.:;]?\s*$/)?.[1]?.trim();
  return role ? compactPendingApprovalText(role) : null;
}

export interface DeliveryOfficeParts {
  officeName: string;
  vehicleNumber: string | null;
}

const VEHICLE_AT_END = /(?:^|[\s,\u2013\u2014-])([a-z]{2}\s*-?\s*\d{1,2}\s*-?\s*[a-z]{1,3}\s*-?\s*\d{4})\s*$/i;

export function comparableVehicleNumber(value?: string | null) {
  return (value ?? "").replace(/[^a-z0-9]/gi, "").toUpperCase();
}

/**
 * Some HCM office labels arrive as `<office>-<vehicle registration>`. Split that
 * legacy combined label for display without changing the office or indent records.
 * An explicit vehicle snapshot wins, while the suffix remains a fallback for older
 * indents that were created before vehicle_id was populated.
 */
export function splitDeliveryOffice(
  officeName?: string | null,
  explicitVehicleNumber?: string | null,
): DeliveryOfficeParts {
  const rawOfficeName = officeName?.trim() ?? "";
  const explicitVehicle = explicitVehicleNumber?.trim() || null;
  const match = rawOfficeName.match(VEHICLE_AT_END);
  const suffixVehicle = match?.[1]?.replace(/\s+/g, "") ?? null;
  const suffixMatchesExplicit = !explicitVehicle
    || comparableVehicleNumber(suffixVehicle) === comparableVehicleNumber(explicitVehicle);
  const cleanOfficeName = match && suffixMatchesExplicit
    ? rawOfficeName.slice(0, match.index).trim()
    : rawOfficeName;

  return {
    officeName: cleanOfficeName || "\u2014",
    vehicleNumber: explicitVehicle ?? suffixVehicle,
  };
}
