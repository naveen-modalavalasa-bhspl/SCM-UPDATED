import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { alerts } from "../alerts";
import { AlertHost } from "../components/AlertHost";
import { AUTO_CLOSE_MS, DEFAULT_CATALOG } from "../catalog";
import { __resetAlerts, interpolate } from "../store";

function mount() {
  return render(<AlertHost />);
}

/** Raising an alert updates the host's state, so React wants it inside act(). */
function raise(open: () => Promise<boolean>): Promise<boolean> {
  let answered!: Promise<boolean>;
  act(() => { answered = open(); });
  return answered;
}

afterEach(() => {
  // In act() too: a test that ends with a dialog still open is torn down here,
  // and that emit reaches the host while it is still mounted.
  act(() => __resetAlerts());
  vi.useRealTimers();
});

describe("the catalog", () => {
  it("never lets a confirm close itself", () => {
    for (const item of Object.values(DEFAULT_CATALOG)) {
      if (item.mode === "confirm") {
        expect(item.auto_close_ms, item.code).toBeNull();
        expect(item.confirm_label, item.code).toBeTruthy();
        expect(item.cancel_label, item.code).toBeTruthy();
      }
    }
  });

  it("keeps warnings and failures on screen", () => {
    for (const item of Object.values(DEFAULT_CATALOG)) {
      if (item.variant === "error" || item.variant === "warning") {
        expect(item.auto_close_ms, item.code).toBeNull();
      }
    }
  });

  it("gives an informational alert three seconds", () => {
    expect(AUTO_CLOSE_MS).toBe(3000);
    expect(DEFAULT_CATALOG["grn.posted"].auto_close_ms).toBe(3000);
    expect(DEFAULT_CATALOG["settings.changed"].auto_close_ms).toBe(3000);
  });

  it("fills placeholders, and leaves a missing one visible", () => {
    expect(interpolate("{qty} of {item}", { qty: 5, item: "Bolt" })).toBe("5 of Bolt");
    expect(interpolate("{qty} of {item}", { qty: 5 })).toBe("5 of {item}");
  });
});

describe("an informational alert", () => {
  beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }));

  it("closes itself after three seconds", async () => {
    mount();
    let settled = false;
    void raise(() => alerts.success("master.saved", { name: "Vendors" }))
      .then(() => { settled = true; });

    expect(await screen.findByText("Saved")).toBeInTheDocument();
    expect(screen.getByText("Your changes to Vendors have been saved.")).toBeInTheDocument();

    // Loose boundaries on purpose: `shouldAdvanceTime` lets the wall clock run
    // too, so asserting on the exact millisecond makes the test flaky. That the
    // delay is 3000 is pinned on the catalog entry itself, above.
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(screen.queryByText("Saved")).toBeInTheDocument();

    await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
    expect(screen.queryByText("Saved")).not.toBeInTheDocument();
    expect(settled).toBe(true);
  });

  it("does not close a failure", async () => {
    mount();
    void raise(() => alerts.error("request.failed"));

    expect(await screen.findByText("Could not save")).toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(screen.getByText("Could not save")).toBeInTheDocument();
  });

  it("does not close a confirm", async () => {
    mount();
    void raise(() => alerts.confirm("user.delete"));

    expect(await screen.findByText("Delete user?")).toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(screen.getByText("Delete user?")).toBeInTheDocument();
  });
});

describe("a confirm", () => {
  it("resolves true only when the primary button is pressed", async () => {
    mount();

    const answered = raise(() => alerts.confirm("po.cancel", { number: "PO-0007" }));
    fireEvent.click(await screen.findByRole("button", { name: /Yes, Cancel PO/ }));

    await expect(answered).resolves.toBe(true);
  });

  it("resolves false on cancel", async () => {
    mount();

    const answered = raise(() => alerts.confirm("item.delete", { name: "Hex Bolt M8" }));
    expect(await screen.findByText(/Hex Bolt M8 has stock/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    await expect(answered).resolves.toBe(false);
  });

  it("resolves false when dismissed with the close button", async () => {
    mount();

    const answered = raise(() => alerts.confirm("grn.post", { location: "WH-01" }));
    fireEvent.click(await screen.findByRole("button", { name: "Close" }));

    await expect(answered).resolves.toBe(false);
  });
});

describe("the queue", () => {
  it("shows one dialog at a time", async () => {
    mount();
    void raise(() => alerts.confirm("user.delete"));
    void raise(() => alerts.confirm("role.delete", { count: 3 }));

    expect(await screen.findByText("Delete user?")).toBeInTheDocument();
    expect(screen.queryByText("Delete role?")).not.toBeInTheDocument();
  });

  it("shows the next one once the first is answered", async () => {
    mount();
    void raise(() => alerts.confirm("user.delete"));
    void raise(() => alerts.confirm("role.delete", { count: 3 }));

    fireEvent.click(await screen.findByRole("button", { name: /Yes, Delete/ }));

    expect(await screen.findByText("Delete role?")).toBeInTheDocument();
    expect(screen.getByText(/3 user\(s\) currently hold this role/)).toBeInTheDocument();
  });
});

describe("a one-off dialog", () => {
  it("needs no catalog entry", async () => {
    mount();
    void raise(() => alerts.show({
      variant: "warning",
      mode: "confirm",
      title: "Close short?",
      message: "12 units still outstanding.",
      confirmLabel: "Close PO",
    }));

    expect(await screen.findByText("Close short?")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Close PO" })).toBeInTheDocument();
  });
});
