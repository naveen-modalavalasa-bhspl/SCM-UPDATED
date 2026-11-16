import { describe, expect, it } from "vitest";
import {
  TRANSFER_ACK_HOME, ackDetailPath, isTransferRow, issueAckDetailPath,
} from "../ackPaths";

// Every stock transfer is received on Inventory > Stock Transfer, never under Indents
// (2026-10-29). The receipt journey is one screen at two addresses.
describe("acknowledgement addresses", () => {
  it("sends an STR to the Stock Transfer desk", () => {
    expect(isTransferRow({ indent_type: "STR" })).toBe(true);
    expect(ackDetailPath(42, true)).toBe("/inventory/transfers/acknowledgements/42");
  });

  it("keeps a departmental indent on the indents desk", () => {
    expect(isTransferRow({ indent_type: "REGULAR" })).toBe(false);
    expect(isTransferRow(undefined)).toBe(false);
    expect(ackDetailPath(42, false)).toBe("/indents/acknowledgements/42");
  });

  it("addresses a direct STO's issue under Stock Transfer and a plain one under Indents", () => {
    expect(issueAckDetailPath(7, true)).toBe("/inventory/transfers/acknowledgements/issue/7");
    expect(issueAckDetailPath(7, false)).toBe("/indents/acknowledgements/issue/7");
  });

  it("returns to the Stock Transfer acknowledgements tab", () => {
    expect(TRANSFER_ACK_HOME).toBe("/inventory/transfers?tab=acknowledge");
  });
});
