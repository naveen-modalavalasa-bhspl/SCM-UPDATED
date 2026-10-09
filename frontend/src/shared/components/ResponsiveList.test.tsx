import { useState } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { ResponsiveList } from "./ResponsiveList";

it("updates controlled desktop cells without replacing the focused input", () => {
  const rows = [{ id: 1, quantity: 10000 }];
  function Editor() {
    const [draft, setDraft] = useState("10000");
    return <ResponsiveList editable data={rows} keyOf={(r) => r.id}
      columns={[{ key: "quantity", header: "Quantity", render: () =>
        <input aria-label="Desktop quantity" value={draft}
          onChange={(e) => setDraft(e.target.value)} /> }]}
      renderCard={() => <span>{draft}</span>} />;
  }
  render(<Editor />);
  const input = screen.getByRole("textbox", { name: "Desktop quantity" });
  act(() => input.focus());
  for (const value of ["1000", "100", "", "9", "99", "999"]) {
    fireEvent.change(input, { target: { value } });
    expect(input).toHaveValue(value);
    expect(screen.getByRole("textbox", { name: "Desktop quantity" })).toBe(input);
    expect(input).toHaveFocus();
  }
});
