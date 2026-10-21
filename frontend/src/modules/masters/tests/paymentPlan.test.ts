import { describe, expect, it } from "vitest";
import {
  PAYMENT_STAGES, planPayload, planProblem, resizeInstalments, stageInstalments,
} from "../paymentPlan";

const delivery = PAYMENT_STAGES.find((s) => s.key === "delivery")!;
const base = { advance_pct: 0, delivery_pct: 100, installation_pct: 0, warranty_pct: 0 };

describe("payment plan", () => {
  it("divides an equal split on the order share, last instalment takes the rounding", () => {
    const v = { ...base, advance_pct: 50, delivery_pct: 50, delivery_split: "EQUAL",
                delivery_instalment_days: "30,60,90" };
    expect(stageInstalments(v, delivery).map((p) => p.orderPct)).toEqual([16.67, 16.67, 16.66]);
    expect(stageInstalments(v, delivery).map((p) => p.code)).toEqual(["DLV 1/3", "DLV 2/3", "DLV 3/3"]);
  });

  it("takes each custom share of the stage", () => {
    const v = { ...base, advance_pct: 70, delivery_pct: 30, delivery_split: "CUSTOM",
                delivery_instalment_days: "30,60,90,120", delivery_instalment_pcts: "30,40,10,20" };
    expect(stageInstalments(v, delivery).map((p) => p.orderPct)).toEqual([9, 12, 3, 6]);
    expect(planProblem(v)).toBeNull();
  });

  it("names what is wrong before Save", () => {
    expect(planProblem({ ...base, delivery_pct: 90 })).toMatch(/add up to 90%/);
    expect(planProblem({ ...base, delivery_split: "CUSTOM", delivery_instalment_days: "30,60",
                         delivery_instalment_pcts: "50,40" })).toMatch(/add up to 90%/);
    expect(planProblem({ ...base, delivery_split: "EQUAL", delivery_instalment_days: "60,30" }))
      .toMatch(/must fall after/);
  });

  it("continues the day rhythm when instalments are added", () => {
    const v = { delivery_instalment_days: "30,60", delivery_instalment_pcts: "50,50" };
    expect(resizeInstalments(v, "delivery", 4).delivery_instalment_days).toBe("30,60,90,120");
    expect(resizeInstalments(v, "delivery", 4).delivery_instalment_pcts).toBe("50,50,,");
  });

  it("sends no stale lists for a single payment", () => {
    const out = planPayload({ ...base, delivery_days: "45", delivery_split: "ONE",
                              delivery_instalment_days: "30,60" });
    expect(out.delivery_instalment_days).toBeNull();
    expect(out.delivery_days).toBe(45);
  });
});
