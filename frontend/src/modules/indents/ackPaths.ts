/**
 * Where an acknowledgement lives (2026-10-29).
 *
 * A stock transfer — an STR, or a direct STO — is received on Inventory > Stock
 * Transfer > Acknowledgements and nowhere else. `/indents/acknowledgements` is the
 * departmental indents' own desk. The receipt journey is ONE screen
 * (`AcknowledgementDetailPage`) mounted at both, so these helpers only decide the
 * address — never a second copy of the rules.
 */
export const TRANSFER_ACK_HOME = "/inventory/transfers?tab=acknowledge";
export const INDENT_ACK_HOME = "/indents/acknowledgements";
export const TRANSFER_ACK_BASE = "/inventory/transfers/acknowledgements";

export const isTransferRow = (row?: { indent_type?: string | null } | null) =>
  row?.indent_type === "STR";

/** The receipt of an indent / STR, at the desk it belongs to. */
export const ackDetailPath = (indentId: number, transfer: boolean) =>
  transfer ? `${TRANSFER_ACK_BASE}/${indentId}` : `${INDENT_ACK_HOME}/${indentId}`;

/** The receipt of an issue with no indent: a direct STO's (transfer) or a plain
 *  direct issue's (indents). */
export const issueAckDetailPath = (issueId: number, transfer: boolean) =>
  transfer ? `${TRANSFER_ACK_BASE}/issue/${issueId}` : `${INDENT_ACK_HOME}/issue/${issueId}`;
