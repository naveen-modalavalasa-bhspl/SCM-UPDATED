import { describe, expect, it } from "vitest";
import { crewProblemCount, crewProblems, makeDriver, resizeCrew } from "../components/crew";

describe("own vehicle crew", () => {
  it("opens exactly as many cards as people going, the first one driving", () => {
    const crew = resizeCrew([], 3);
    expect(crew).toHaveLength(3);
    expect(crew.map((p) => p.role)).toEqual(["DRIVER", "HELPER", "HELPER"]);
  });

  it("keeps what was typed when the count changes", () => {
    const crew = resizeCrew([{ role: "DRIVER", name: "Ravi", phone: "9493746163" }], 2);
    expect(crew[0].name).toBe("Ravi");
    expect(resizeCrew(crew, 1)).toHaveLength(1);
  });

  it("says when the names do not match the count, and what each card lacks", () => {
    const { general, byPerson } = crewProblems(2, [{ role: "HELPER", name: "", phone: "123" }]);
    expect(general.join(" ")).toMatch(/2 people are going but 1 is filled in/);
    expect(general.join(" ")).toMatch(/Mark one person as the driver/);
    expect(byPerson[0]).toEqual(["Enter the name.", "Enter a 10-digit mobile number."]);
  });

  it("allows one driver and no repeated number", () => {
    const crew = makeDriver([
      { role: "DRIVER", name: "Ravi", phone: "9493746163" },
      { role: "HELPER", name: "Anil", phone: "9493746163" },
    ], 1);
    expect(crew.map((p) => p.role)).toEqual(["HELPER", "DRIVER"]);
    expect(crewProblems(2, crew).byPerson[1]).toEqual(["This number is already given for person 1."]);
  });

  it("passes a complete crew", () => {
    expect(crewProblemCount(2, [
      { role: "DRIVER", name: "Ravi", phone: "9493746163" },
      { role: "HELPER", name: "Anil", phone: "9876543210" },
    ])).toBe(0);
  });
});
