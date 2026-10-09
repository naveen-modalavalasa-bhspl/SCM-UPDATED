import { describe, expect, it } from "vitest";
import { carrierPortalApi, consignmentApi, grnApi, issueApi, stockApi, transportApi } from "../api";

describe("logistics api", () => {
  it("exposes GRN operations", () => {
    expect(Object.keys(grnApi).sort()).toEqual(
      ["createFromPo", "get", "list", "qcFail", "qcPass"].sort(),
    );
  });
  it("exposes stock + issue reads", () => {
    expect(typeof stockApi.list).toBe("function");
    expect(typeof stockApi.movements).toBe("function");
    expect(typeof issueApi.issue).toBe("function");
  });

  it("covers every stage of the transport flow", () => {
    // One document from planning to signature: the stages that used to be a second
    // "dispatch" screen are calls on this one.
    for (const call of [
      "list", "get", "create", "update", "submit", "approve", "invite", "award",
      "confirmCarrier", "carrierDeclined", "dispatch", "addEvent", "deliver",
      "close", "shareTracking", "summary", "flow", "forConsignments",
      "receiptEvidence", "downloadReceiptEvidence",
    ]) {
      expect(typeof (transportApi as Record<string, unknown>)[call]).toBe("function");
    }
  });

  it("reads consignments but never writes them", () => {
    // The consignment is the warehouse's document. This module plans transport for
    // it; it must not be able to create, edit or delete one.
    expect(Object.keys(consignmentApi).sort()).toEqual(["get", "list"]);
  });

  it("gives the carrier what they can do to a job, and nothing more", () => {
    // `acknowledge` is the award answered WITH the driver and vehicle. How the load
    // travels is NOT theirs to pick: the desk settled the carriage at dispatch and
    // the award was priced against it. Still no create, edit or delete: a carrier
    // answers a shipment, it never raises one. `deliverStop` is one stop of a
    // multi-drop run — still their word about their own truck, never a signature.
    expect(Object.keys(carrierPortalApi).sort()).toEqual(
      ["accept", "acknowledge", "decline", "deliver", "deliverStop", "get", "list",
       "quote", "summary", "track"].sort(),
    );
  });

  it("asks about a page of consignments in one call, and skips an empty page", async () => {
    await expect(transportApi.forConsignments([])).resolves.toEqual([]);
  });
});
