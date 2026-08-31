import { describe, expect, it } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AxiosError, type InternalAxiosRequestConfig } from "axios";
import { ErrorBanner } from "./Feedback";
import { ToastProvider } from "./Toast";
import { useAction } from "./useAction";

/**
 * The rule that stops one refused save being announced twice.
 *
 * Twelve screens pin a mutation's error to an `<ErrorBanner>` and run that same
 * mutation through `useAction`, which toasts failures as a backstop. Whether the
 * toast appears has to depend on whether the banner is there — and neither of them
 * can see the other, so the coordination is worth pinning.
 */

function refusal(status: number, message: string) {
  const config = {
    url: "/api/indents/7/submit", method: "post", headers: {},
  } as InternalAxiosRequestConfig;
  return new AxiosError(`Request failed with status code ${status}`, String(status),
    config, {}, {
      data: { error: message, title: "Check the details entered" },
      status, statusText: "", headers: {}, config,
    });
}

function Screen({ pin, error }: { pin: boolean; error: AxiosError }) {
  const submit = useAction({
    run: async () => { throw error; },
    success: "Indent submitted for approval.",
  });
  return (
    <>
      {pin && <ErrorBanner error={submit.error} />}
      <button onClick={() => submit.mutate()}>Submit</button>
    </>
  );
}

function mount(pin: boolean, error: AxiosError) {
  const qc = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ToastProvider><Screen pin={pin} error={error} /></ToastProvider>
    </QueryClientProvider>,
  );
}

/** Past the one tick `useAction` waits for the banner to commit. */
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 20)); });

describe("useAction reporting a failure", () => {
  it("stays quiet when the screen pins the reason next to the form", async () => {
    const error = refusal(422, "Indent must have at least one item");
    mount(true, error);

    screen.getByText("Submit").click();
    await waitFor(() => expect(screen.getAllByText("Indent must have at least one item"))
      .toHaveLength(1));
    await settle();

    // Still exactly one on screen: the banner. No toast repeating it.
    expect(screen.getAllByText("Indent must have at least one item")).toHaveLength(1);
  });

  it("toasts when the screen has nowhere to pin it", async () => {
    mount(false, refusal(422, "Indent must have at least one item"));

    screen.getByText("Submit").click();
    await settle();

    expect(screen.getByText("Indent must have at least one item")).toBeInTheDocument();
    expect(screen.getByText("Check the details entered")).toBeInTheDocument();
  });

  it("leaves an expired session to the one dialog that already announces it", async () => {
    mount(false, refusal(401, "Invalid or expired token"));

    screen.getByText("Submit").click();
    await settle();

    // The shared interceptor is redirecting to the sign-in page as this runs.
    expect(screen.queryByText(/session/i)).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
