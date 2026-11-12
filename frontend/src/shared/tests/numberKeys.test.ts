import { describe, expect, it, vi } from "vitest";
import { guardNumberKeys } from "../quantity";

function press(key: string, el: { min?: string; step?: string; value?: string } = {}, mods = {}) {
  const preventDefault = vi.fn();
  guardNumberKeys({ key, ctrlKey: false, metaKey: false, altKey: false,
                    preventDefault, currentTarget: el, ...mods });
  return preventDefault.mock.calls.length === 1;
}

describe("guardNumberKeys", () => {
  it("refuses exponent and sign keys the browser would let through", () => {
    for (const k of ["e", "E", "+"]) expect(press(k)).toBe(true);
  });
  it("refuses minus only on a non-negative box", () => {
    expect(press("-", { min: "0" })).toBe(true);
    expect(press("-", { min: "1" })).toBe(true);
    expect(press("-")).toBe(false);
    expect(press("-", { min: "-5" })).toBe(false);
  });
  it("refuses the decimal point only when the step is a whole number", () => {
    expect(press(".", { step: "1", value: "5" })).toBe(true);
    expect(press(",", { step: "1", value: "5" })).toBe(true);
    expect(press(".", { step: "0.001", value: "5" })).toBe(false);
    expect(press(".", { step: "any", value: "5" })).toBe(false);
    expect(press(".", { value: "5" })).toBe(false);
  });
  it("refuses a point into an empty box — no quantity starts with one (SCM_0156)", () => {
    expect(press(".", { step: "0.001" })).toBe(true);
    expect(press(".", { step: "any", value: "" })).toBe(true);
  });
  it("leaves digits, editing keys and shortcuts alone", () => {
    for (const k of ["0", "9", "Backspace", "Tab", "ArrowLeft", "Enter"]) expect(press(k, { min: "0", step: "1" })).toBe(false);
    expect(press("e", {}, { ctrlKey: true })).toBe(false);
    expect(press("e", {}, { metaKey: true })).toBe(false);
  });
});
