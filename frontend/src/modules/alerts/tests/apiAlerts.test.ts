import { afterEach, beforeAll, describe, expect, it } from "vitest";
import axios, { AxiosError, type InternalAxiosRequestConfig } from "axios";
import { api } from "@/shared/api/client";
import { installApiAlerts } from "../apiAlerts";
import { __resetAlerts, getSnapshot } from "../store";

/**
 * These pin the interceptor CHAIN, not the dialog.
 *
 * `shared/api/client.ts` runs first and rewrites the message; this module's
 * interceptor runs second and decides which dialog to raise. When the first one
 * rejected with a fresh `new Error(...)`, the second saw no `response` and no
 * `config` on anything, so every single failure — a 422, a 403, a 500, a request
 * TanStack Query cancelled on navigation — came out as "Can't reach the server".
 * Each case below is one branch that was unreachable.
 */

function adapterThrowing(error: unknown) {
  api.defaults.adapter = async () => {
    throw error;
  };
}

/** A failure the server answered: carries a response, like the real thing. */
function serverError(status: number, body: unknown = {}) {
  const config = { url: "/api/test", method: "get", headers: {} } as InternalAxiosRequestConfig;
  const response = { data: body, status, statusText: "", headers: {}, config };
  adapterThrowing(
    new AxiosError(`Request failed with status code ${status}`, String(status), config, {}, response),
  );
}

/** Nothing came back at all: no response, the genuine unreachable case. */
function noResponse() {
  const config = { url: "/api/test", method: "get", headers: {} } as InternalAxiosRequestConfig;
  adapterThrowing(new AxiosError("Network Error", AxiosError.ERR_NETWORK, config, {}));
}

async function failingRequest(): Promise<Error> {
  return api.get("/api/test").then(
    () => { throw new Error("expected the request to fail"); },
    (error: Error) => error,
  );
}

const raised = () => getSnapshot().map((item) => item.title);

beforeAll(() => installApiAlerts());
afterEach(() => __resetAlerts());

describe("the shared client", () => {
  it("keeps the axios error intact so later interceptors can read it", async () => {
    serverError(500, { error: "boom" });
    const error = await failingRequest();

    expect((error as AxiosError).response?.status).toBe(500);
    expect((error as AxiosError).config?.url).toBe("/api/test");
    // Still the message every onError handler shows inline.
    expect(error.message).toBe("boom");
  });

  it("explains an unreachable API in the message", async () => {
    noResponse();
    const error = await failingRequest();

    expect(error.message).toContain("Cannot reach the API");
    expect(error.message).toContain("/api/test");
  });
});

describe("the alert interceptor", () => {
  it("announces a server error as a failure, not a dropped connection", async () => {
    serverError(500);
    await failingRequest();

    expect(raised()).toEqual(["Something went wrong"]);
  });

  // Disabled by request: a 403 raises no popup, it only re-rejects.
  it("stays quiet on a 403", async () => {
    serverError(403, { error: "Missing permission: indent.view" });
    await failingRequest();

    expect(raised()).toEqual([]);
  });

  it("stays quiet on a 422 — the screen shows those inline", async () => {
    serverError(422, { error: "Quantity must be greater than zero" });
    await failingRequest();

    expect(raised()).toEqual([]);
  });

  it("stays quiet on a 404", async () => {
    serverError(404);
    await failingRequest();

    expect(raised()).toEqual([]);
  });

  it("announces a dropped connection only when there is really no response", async () => {
    noResponse();
    await failingRequest();

    expect(raised()).toEqual(["Can't reach the server"]);
  });

  it("says nothing when a request is cancelled", async () => {
    // What TanStack Query does to every in-flight read when a screen unmounts or
    // a filter changes. Nobody is waiting for an answer, so nobody is told.
    adapterThrowing(new axios.CanceledError("canceled"));
    await failingRequest();

    expect(raised()).toEqual([]);
  });

  it("never announces the catalog fetch failing", async () => {
    const config = {
      url: "/api/alerts/catalog", method: "get", headers: {},
    } as InternalAxiosRequestConfig;
    adapterThrowing(new AxiosError("Network Error", AxiosError.ERR_NETWORK, config, {}));
    await api.get("/api/alerts/catalog").catch(() => undefined);

    expect(raised()).toEqual([]);
  });
});
