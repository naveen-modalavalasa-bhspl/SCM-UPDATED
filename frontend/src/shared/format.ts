/**
 * Formats a purchase order number to include its revision version.
 * If revisionNo is 0, appends -v1.0
 * If revisionNo is > 0, appends -v1.0.{revisionNo}
 */
export function formatPONo(poNo: string | null | undefined, revisionNo?: number | null): string {
  if (!poNo) return "—";
  if (revisionNo == null) return poNo;
  
  if (revisionNo === 0) {
    return `${poNo}-v1.0`;
  }
  return `${poNo}-v1.0.${revisionNo}`;
}
