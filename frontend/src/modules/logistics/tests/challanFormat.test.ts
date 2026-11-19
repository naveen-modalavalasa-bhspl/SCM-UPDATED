import { describe, expect, it } from "vitest";
import {
  dimensions, indianWords, money, qty, rupeesInWords, volume, weight,
} from "../components/challanFormat";

describe("challan numbers", () => {
  it("writes money in Indian grouping at two decimals", () => {
    expect(money("123456.5")).toBe("1,23,456.50");
    expect(money(null)).toBe("0.00");
  });

  it("drops trailing zeros from a quantity", () => {
    expect(qty("12.000")).toBe("12");
    expect(qty("2.500")).toBe("2.5");
  });

  it("says nothing for an unmeasured weight or volume, never 0", () => {
    expect(weight("0")).toBeNull();
    expect(weight(null)).toBeNull();
    expect(weight("12.5")).toBe("12.5 kg");
    expect(volume(undefined)).toBeNull();
    expect(volume("0.045")).toBe("0.045 m³");
  });

  it("prints dimensions only when all three sides are measured", () => {
    expect(dimensions(["40", "30", "20"])).toBe("40 × 30 × 20 cm");
    expect(dimensions(["40", null, "20"])).toBeNull();
  });

  it("writes the total in words, the Indian way", () => {
    expect(indianWords(0)).toBe("Zero");
    expect(indianWords(105)).toBe("One Hundred Five");
    expect(indianWords(123456)).toBe("One Lakh Twenty Three Thousand Four Hundred Fifty Six");
    expect(indianWords(12_00_00_000)).toBe("Twelve Crore");
    expect(rupeesInWords("1500.50")).toBe("Rupees One Thousand Five Hundred and Paise Fifty Only");
    expect(rupeesInWords(0)).toBe("Rupees Zero Only");
  });
});
