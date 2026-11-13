import { describe, expect, it } from "vitest";
import { switchHandoverPerson } from "../components/HandoverCustody";

/** SCM_0131: picking "Others" must not leave the issue's employee in the boxes. */
const prefill = { name: "Phani Uddhagiri", code: "HR-EMP-15457", phone: "9876543210" };
const employee = {
  handed_over_by_name: prefill.name, handed_over_employee_id: prefill.code,
  handed_over_aadhaar: "", handed_over_phone: prefill.phone,
};

describe("switchHandoverPerson", () => {
  it("Others takes the prefilled employee away", () => {
    expect(switchHandoverPerson(employee, "OTHERS", prefill)).toEqual({
      handed_over_by_name: "", handed_over_employee_id: "",
      handed_over_aadhaar: "", handed_over_phone: "",
    });
  });

  it("never wipes what the desk typed itself", () => {
    const typed = { ...employee, handed_over_by_name: "Ravi (driver)", handed_over_phone: "9000000001" };
    const out = switchHandoverPerson(typed, "OTHERS", prefill);
    expect(out.handed_over_by_name).toBe("Ravi (driver)");
    expect(out.handed_over_phone).toBe("9000000001");
  });

  it("Employee brings the prefill back into empty boxes", () => {
    const blank = { handed_over_by_name: "", handed_over_employee_id: "",
                    handed_over_aadhaar: "123412341234", handed_over_phone: "" };
    expect(switchHandoverPerson(blank, "EMPLOYEE", prefill)).toEqual({ ...employee });
  });
});
