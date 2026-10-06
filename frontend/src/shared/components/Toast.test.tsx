import { afterEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { AxiosError, type InternalAxiosRequestConfig } from "axios";
import { ToastProvider, useToast } from "./Toast";

/**
 * The rules a notification strip lives or dies by: it does not repeat itself, it
 * does not pile up, and a failure does not disappear before it is read.
 */

let api: ReturnType<typeof useToast>;

function Probe() {
  api = useToast();
  return null;
}

function mount() {
  render(<ToastProvider><Probe /></ToastProvider>);
}

const shown = () => screen.queryAllByRole("status").concat(screen.queryAllByRole("alert"));

afterEach(() => vi.useRealTimers());

describe("the toast strip", () => {
  it("says the same thing once, however many times it is raised", () => {
    mount();
    act(() => {
      api.error("Indent could not be submitted.");
      api.error("Indent could not be submitted.");
      api.error("Indent could not be submitted.");
    });

    expect(shown()).toHaveLength(1);
  });

  it("keeps at most three on screen", () => {
    mount();
    act(() => {
      api.error("One");
      api.error("Two");
      api.error("Three");
      api.error("Four");
    });

    expect(shown()).toHaveLength(3);
    // The oldest goes: a wall of four is a wall nobody reads.
    expect(screen.queryByText("One")).toBeNull();
    expect(screen.getByText("Four")).toBeInTheDocument();
  });

  it("closes a success on its own and leaves a failure up", () => {
    vi.useFakeTimers();
    mount();
    act(() => {
      api.success("Indent submitted for approval.");
      api.error("Indent could not be submitted.");
    });
    expect(shown()).toHaveLength(2);

    act(() => { vi.advanceTimersByTime(10_000); });

    // A failure that vanishes reads as a success.
    expect(screen.queryByText("Indent submitted for approval.")).toBeNull();
    expect(screen.getByText("Indent could not be submitted.")).toBeInTheDocument();
  });

  it("words a caught failure from the one central translation", () => {
    mount();
    const config = {
      url: "/api/indents/7/approve", method: "post", headers: {},
    } as InternalAxiosRequestConfig;
    act(() => api.fromError(new AxiosError("Request failed with status code 403", "403",
      config, {}, {
        data: { error: "This indent is not assigned to you at the current stage." },
        status: 403, statusText: "", headers: {}, config,
      })));

    // The server's reason, under the heading the status earns — and no "403".
    expect(screen.getByText("Not allowed")).toBeInTheDocument();
    expect(
      screen.getByText("This indent is not assigned to you at the current stage."),
    ).toBeInTheDocument();
  });
});
