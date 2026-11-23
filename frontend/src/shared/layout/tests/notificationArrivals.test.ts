import { describe, expect, it } from "vitest";
import { arrivals, desktopBatch, shouldAutoClose, shouldOpenPanel } from "../notificationArrivals";

describe("notification arrivals", () => {
  it("the first read only sets the mark", () => {
    const r = arrivals([{ id: 5, is_read: false }, { id: 3, is_read: false }], null);
    expect(r).toEqual({ fresh: [], seenUpTo: 5 });
  });
  it("later reads report unread rows above the mark", () => {
    const r = arrivals([{ id: 8, is_read: false }, { id: 7, is_read: true }, { id: 5, is_read: false }], 5);
    expect(r).toEqual({ fresh: [8], seenUpTo: 8 });
  });
  it("opens only when visible and no dialog is open", () => {
    expect(shouldOpenPanel({ fresh: 1, dialogOpen: false, visible: true })).toBe(true);
    expect(shouldOpenPanel({ fresh: 1, dialogOpen: true, visible: true })).toBe(false);
    expect(shouldOpenPanel({ fresh: 1, dialogOpen: false, visible: false })).toBe(false);
    expect(shouldOpenPanel({ fresh: 0, dialogOpen: false, visible: true })).toBe(false);
  });
  it("an urgent arrival keeps the panel open", () => {
    expect(shouldAutoClose([{ id: 9, entity_type: "APPROVAL_STUCK" }], [9])).toBe(false);
    expect(shouldAutoClose([{ id: 9, entity_type: "PO" }], [9])).toBe(true);
  });
  it("a burst becomes one desktop pop-up", () => {
    const rows = [1, 2, 3, 4].map((id) => ({ id, title: `T${id}`, body: "" }));
    expect(desktopBatch(rows)).toHaveLength(1);
    expect(desktopBatch(rows)[0].title).toBe("4 new notifications");
    expect(desktopBatch(rows.slice(0, 2))).toHaveLength(2);
  });
});
