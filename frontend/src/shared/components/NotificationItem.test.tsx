import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { NotificationItem } from "./NotificationItem";
import { hasDocument, notificationHref, notificationKind, type NotificationRow } from "@/shared/api/notifications";

// SCM_0074 / SCM_0075: clicking a notification always goes somewhere.
const row = (over: Partial<NotificationRow> = {}): NotificationRow => ({
  id: 41, title: "PO0001 approved", body: "Your order was approved.", entity_type: "PO",
  entity_id: 12, deep_link: "/approvals", target: "/pos/12", is_read: false,
  created_at: new Date().toISOString(), ...over,
});

describe("where a notification opens", () => {
  it("opens the server-resolved document", () => {
    expect(notificationHref(row())).toBe("/pos/12");
    expect(hasDocument(row())).toBe(true);
  });

  it("opens the inbox focused on itself when nothing stands behind it", () => {
    const bare = row({ target: null, deep_link: null });
    expect(notificationHref(bare)).toBe("/notifications?tab=all&focus=41");
    expect(hasDocument(bare)).toBe(false);
  });

  it("reads the kind off the entity type", () => {
    expect(notificationKind(row())).toBe("procurement");
    expect(notificationKind(row({ entity_type: "INDENT_STATUS:ALLOCATED" }))).toBe("indent");
    expect(notificationKind(row({ entity_type: "WH_ISSUE" }))).toBe("warehouse");
    expect(notificationKind(row({ entity_type: null }))).toBe("update");
  });
});

describe("NotificationItem", () => {
  it("navigates to the document and tells the caller it was opened", () => {
    const onOpen = vi.fn();
    render(
      <MemoryRouter initialEntries={["/"]}>
        <Routes>
          <Route path="/" element={<NotificationItem row={row()} onOpen={onOpen} />} />
          <Route path="/pos/:id" element={<p>PO detail</p>} />
        </Routes>
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole("link", { name: /PO0001 approved/ }));
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ id: 41 }));
    expect(screen.getByText("PO detail")).toBeInTheDocument();
  });

  it("marks read without opening", () => {
    const onOpen = vi.fn();
    const onMarkRead = vi.fn();
    render(
      <MemoryRouter>
        <NotificationItem row={row()} onOpen={onOpen} onMarkRead={onMarkRead} />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole("button", { name: /Mark .* as read/ }));
    expect(onMarkRead).toHaveBeenCalled();
    expect(onOpen).not.toHaveBeenCalled();
  });
});
