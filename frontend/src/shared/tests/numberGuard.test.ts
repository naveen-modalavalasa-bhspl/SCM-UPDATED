import { beforeAll, describe, expect, it } from "vitest";
import {
  charAllowed, installNumberGuard, leadingPoint, ruleFor, setUomDecimals, textAllowed, uomDecimals,
} from "../numberGuard";

/** Quantity boxes refuse what the save would refuse, as it is typed (2026-11-03). */

const box = (attrs: Record<string, string>) => {
  const el = document.createElement("input");
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  document.body.appendChild(el);
  return el;
};

const press = (el: HTMLInputElement, key: string) => {
  const ev = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
  el.dispatchEvent(ev);
  return !ev.defaultPrevented;
};

const paste = (el: HTMLInputElement, text: string) => {
  const ev = new Event("paste", { bubbles: true, cancelable: true }) as ClipboardEvent;
  Object.defineProperty(ev, "clipboardData", { value: { getData: () => text } });
  el.dispatchEvent(ev);
  return !ev.defaultPrevented;
};

beforeAll(() => {
  setUomDecimals([
    { code: "NOS", name: "Numbers", decimals: 0 },
    { code: "KG", name: "Kilogram", decimals: 3 },
  ]);
  installNumberGuard();
});

describe("the unit table resolves exactly as the save does", () => {
  it("by code, by code case-folded, then by name", () => {
    expect(uomDecimals("NOS")).toBe(0);
    expect(uomDecimals("nos")).toBe(0);
    expect(uomDecimals("numbers")).toBe(0);
    expect(uomDecimals("KG")).toBe(3);
    expect(uomDecimals("unknown")).toBeNull();
  });
});

describe("pure rules", () => {
  it("a whole unit takes digits only", () => {
    const rule = { decimals: 0, negative: false };
    expect(charAllowed("7", rule)).toBe(true);
    expect(charAllowed(".", rule)).toBe(false);
    expect(charAllowed("e", rule)).toBe(false);
    expect(charAllowed("-", rule)).toBe(false);
    expect(textAllowed("12", rule)).toBe(true);
    expect(textAllowed("12.5", rule)).toBe(false);
  });

  it("a measured unit takes a point, up to its places", () => {
    const rule = { decimals: 3, negative: false };
    expect(charAllowed(".", rule)).toBe(true);
    expect(textAllowed("1.25", rule)).toBe(true);
    expect(textAllowed("1.2345", rule)).toBe(false);
    expect(textAllowed("12 pcs", rule)).toBe(false);
    expect(textAllowed("1e3", rule)).toBe(false);
  });
});

describe("in the page", () => {
  it("every numeric box refuses letters, e and +", () => {
    const el = box({ type: "number" });
    expect(press(el, "5")).toBe(true);
    expect(press(el, "a")).toBe(false);
    expect(press(el, "e")).toBe(false);
    expect(press(el, "+")).toBe(false);
    expect(press(el, "Backspace")).toBe(true);
  });

  it("a whole-unit quantity refuses the point; a measured one accepts it", () => {
    // After a digit: a point into an EMPTY box is refused for every unit (SCM_0156).
    const typed = (attrs: Record<string, string>) => {
      const el = box(attrs);
      el.value = "5";
      return el;
    };
    expect(press(typed({ type: "number", "data-uom": "NOS" }), ".")).toBe(false);
    expect(press(typed({ type: "number", "data-uom": "KG" }), ".")).toBe(true);
    expect(press(typed({ type: "number", "data-decimals": "0" }), ".")).toBe(false);
    expect(press(box({ type: "number", "data-uom": "KG" }), ".")).toBe(false);
  });

  it("the point is allowed ONLY where a UOM type says so (2026-11-03)", () => {
    // A unit nobody defined, and a line with no unit picked yet, are both whole.
    expect(press(box({ type: "number", "data-uom": "GRAM" }), ".")).toBe(false);
    expect(press(box({ type: "number", "data-uom": "" }), ".")).toBe(false);
    expect(paste(box({ type: "number", "data-uom": "GRAM" }), "2.5")).toBe(false);
  });

  it("a quantity never goes negative; a box with no floor (a temperature) still can", () => {
    expect(press(box({ type: "number", "data-uom": "KG" }), "-")).toBe(false);
    expect(press(box({ type: "number", min: "0" }), "-")).toBe(false);
    expect(ruleFor(box({ type: "number" })).negative).toBe(true);
  });

  it("a paste that is not a number for the box is refused whole", () => {
    const whole = box({ type: "number", "data-uom": "NOS" });
    expect(paste(whole, "12")).toBe(true);
    expect(paste(whole, "12.5")).toBe(false);
    expect(paste(whole, "12abc")).toBe(false);
  });

  it("plain text boxes are left alone", () => {
    expect(press(box({ type: "text" }), "a")).toBe(true);
  });
});

describe("no quantity starts with a point (SCM_0156)", () => {
  it("refuses a pasted .5 but takes 0.5 and a half-typed 5.", () => {
    const rule = { decimals: 3, negative: false };
    expect(textAllowed(".5", rule)).toBe(false);
    expect(textAllowed("0.5", rule)).toBe(true);
    expect(textAllowed("5.", rule)).toBe(true);
  });
  it("refuses a point typed into an empty box", () => {
    const box = document.createElement("input");
    box.type = "text";
    box.value = "";
    expect(leadingPoint(box, ".")).toBe(true);
    box.value = "5";
    box.setSelectionRange(1, 1);
    expect(leadingPoint(box, ".")).toBe(false);
  });
  it("leaves a box that writes the zero itself alone", () => {
    const box = document.createElement("input");
    box.dataset.leadingZero = "auto";
    expect(leadingPoint(box, ".")).toBe(false);
  });
});
