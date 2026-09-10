import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ImportReview } from "../components/ImportReview";
import type { ImportPreview } from "../api";

const preview: ImportPreview = {
  success: false,
  columns: [
    { field: "code", label: "Code", required: true, lookup: false, choices: [], type: "text" },
    { field: "name", label: "Name", required: true, lookup: false, choices: [], type: "text" },
  ],
  rows: [{ row: 2, values: { code: "BOLT" }, problems: [{
    row: 2, field: "name", label: "Name", raw: null,
    message: "Field required", candidates: [],
  }] }],
  options: {}, file_errors: [], summary: { total: 1, ready: 0, blocked: 1 },
};

describe("ImportReview", () => {
  it("lets a user repair a missing normal field without returning to Excel", () => {
    const onCommit = vi.fn();
    render(<ImportReview preview={preview} label="Items" busy={false}
                         onCommit={onCommit} onCancel={vi.fn()} />);

    fireEvent.click(screen.getByText("Edit this row here"));
    fireEvent.change(screen.getByLabelText("Name *"), { target: { value: "Bolt" } });
    fireEvent.click(screen.getByRole("button", { name: "Save these rows" }));

    expect(onCommit).toHaveBeenCalledWith([expect.objectContaining({
      row: 2, values: expect.objectContaining({ code: "BOLT", name: "Bolt" }),
    })]);
  });

  it("requires an explicit save even when every uploaded row is clean", () => {
    const onCommit = vi.fn();
    const clean: ImportPreview = {
      ...preview, success: true,
      rows: [{ row: 2, values: { code: "BOLT", name: "Bolt" }, problems: [] }],
      summary: { total: 1, ready: 1, blocked: 0 },
    };
    render(<ImportReview preview={clean} label="Items" busy={false}
                         onCommit={onCommit} onCancel={vi.fn()} />);

    expect(onCommit).not.toHaveBeenCalled();
    expect(screen.getByText("Every row read cleanly. Press Save to write them.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Save these rows" }));
    expect(onCommit).toHaveBeenCalledTimes(1);
  });
});
