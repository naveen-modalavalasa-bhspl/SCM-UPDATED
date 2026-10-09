import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  installGlobalErrorLogging,
  reportFrontendError,
  sanitizeDiagnosticContext,
} from "@/shared/errorLogging";

describe("frontend error logging", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.unstubAllGlobals();
  });

  it("recursively redacts secrets, removes bodies/query values, and bounds context", () => {
    const safe = sanitizeDiagnosticContext({
      kind: "api",
      nested: {
        password: "do-not-send",
        token: "do-not-send",
        attempt: 2,
      },
      request_body: { email: "person@example.com" },
      query: { project: "42" },
    });
    const serialized = JSON.stringify(safe);

    expect(serialized).not.toContain("do-not-send");
    expect(serialized).not.toContain("person@example.com");
    expect(serialized).not.toContain('"42"');
    expect(safe?.nested).toEqual({
      password: "[REDACTED]",
      token: "[REDACTED]",
      attempt: 2,
    });
  });

  it("uses raw fetch, strips URL query values, and never throws when reporting fails", async () => {
    localStorage.setItem("token", "auth-token-used-only-as-a-header");
    const fetchMock = vi.fn().mockRejectedValue(new Error("offline"));
    vi.stubGlobal("fetch", fetchMock);

    expect(() => reportFrontendError({
      message: "Failed token=do-not-send",
      error_type: "TypeError",
      endpoint: "/api/items?project=42&token=do-not-send",
      page_url: "http://ignored.test/path?secret=do-not-send",
      request_id: "shared-123",
      context: { kind: "api", password: "do-not-send" },
    })).not.toThrow();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(String(init.body));
    expect(url).toContain("/api/admin/app-logs/client-errors");
    expect(body.endpoint).toBe("/api/items");
    expect(body.page_url).toBe(`${window.location.origin}${window.location.pathname}`);
    expect(body.message).not.toContain("do-not-send");
    expect(JSON.stringify(body.context)).not.toContain("do-not-send");
    await Promise.resolve();
  });

  it("global error and rejection handlers do not throw when fetch rejects", () => {
    localStorage.setItem("token", "auth-token");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    installGlobalErrorLogging();

    expect(() => window.dispatchEvent(new ErrorEvent("error", {
      message: "Render failed",
      error: new Error("Render failed"),
    }))).not.toThrow();

    const rejection = new Event("unhandledrejection");
    Object.defineProperty(rejection, "reason", {
      value: { password: "must-not-be-stringified" },
    });
    expect(() => window.dispatchEvent(rejection)).not.toThrow();
  });

  it("never reports failures from the logging endpoint recursively", () => {
    localStorage.setItem("token", "auth-token");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    reportFrontendError({
      message: "Logger failed",
      endpoint: "/api/admin/app-logs/client-errors",
    });

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
