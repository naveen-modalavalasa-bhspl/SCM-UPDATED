import { describe, expect, it } from "vitest";
import axios, { AxiosError, type InternalAxiosRequestConfig } from "axios";
import { claimError, describeError, isAnnouncedGlobally, isErrorClaimed } from "./errors";

/**
 * The one translation from a failure to a sentence, pinned.
 *
 * Every screen in the app shows what comes out of here — through `error.message`,
 * `<ErrorBanner>` or a toast — so the rules worth protecting are the two the module
 * exists for: the server's own reason reaches the user, and nothing technical does.
 */

function failure(status: number, data: unknown = {}, url = "/api/indents/7/submit") {
  const config = { url, method: "post", headers: {} } as InternalAxiosRequestConfig;
  return new AxiosError(
    `Request failed with status code ${status}`,
    String(status),
    config,
    {},
    { data, status, statusText: "", headers: {}, config },
  );
}

function offline(url = "/api/indents") {
  const config = { url, method: "get", headers: {} } as InternalAxiosRequestConfig;
  return new AxiosError("Network Error", AxiosError.ERR_NETWORK, config, {});
}

describe("describeError", () => {
  it("keeps the server's business reason word for word", () => {
    const notice = describeError(failure(422, {
      error: "Indent must have at least one item",
      error_code: "VALIDATION_ERROR",
      title: "Check the details entered",
      field: "items",
    }));

    expect(notice.message).toBe("Indent must have at least one item");
    expect(notice.title).toBe("Check the details entered");
    expect(notice.field).toBe("items");
    // Fixable on this screen, so amber rather than red.
    expect(notice.level).toBe("warning");
  });

  it("answers a permission failure without an HTTP status in it", () => {
    const notice = describeError(failure(403, {}));

    expect(notice.level).toBe("error");
    expect(notice.title).toBe("You don't have permission");
    expect(notice.message).toContain("You don't have permission to perform this action");
    expect(notice.message).not.toMatch(/403|forbidden/i);
  });

  it("never repeats a 5xx body, whatever is in it", () => {
    const notice = describeError(failure(500, {
      error: 'sqlalchemy.exc.OperationalError: (1054, "Unknown column \'x\'")',
    }));

    expect(notice.message).toContain("server problem");
    expect(notice.message).toContain("Nothing was saved");
    expect(notice.message).not.toMatch(/sqlalchemy|1054|column/i);
  });

  it("drops a technical sentence that reached a 4xx body", () => {
    const notice = describeError(failure(400, {
      error: "Traceback (most recent call last): File \"app/service.py\", line 12",
    }));

    expect(notice.message).not.toMatch(/traceback|service\.py/i);
    expect(notice.message).toContain("Correct them and try again");
  });

  it("says nothing about proxies when the server is unreachable", () => {
    const notice = describeError(offline());

    expect(notice.level).toBe("error");
    expect(notice.title).toBe("Can't reach the server");
    expect(notice.message).toContain("Unable to connect to the server");
  });

  it("tells a rejected sign-in apart from an expired session", () => {
    const rejected = describeError(failure(401, {
      error: "The employee ID or password you entered is incorrect. Please try again.",
      title: "Sign-in failed",
    }, "/api/auth/login"));
    // The server's wording, which never says whether the account exists.
    expect(rejected.message).toContain("incorrect");
    expect(rejected.message).not.toMatch(/expired|no such|unknown user/i);

    const expired = describeError(failure(401, { error: "Invalid or expired token" },
      "/api/indents"));
    expect(expired.title).toBe("Signed out");
    expect(expired.message).toContain("Sign in again");
    // "Invalid or expired token" is a fact about a JWT, not an answer to a person.
    expect(expired.message).not.toMatch(/token/i);
  });

  it("leaves a screen's own thrown message alone, with no invented heading", () => {
    const notice = describeError(new Error("Pick at least one indent to submit"));

    expect(notice.message).toBe("Pick at least one indent to submit");
    expect(notice.title).toBeUndefined();
  });

  it("treats a cancelled request as no news at all", () => {
    expect(describeError(new axios.CanceledError("canceled")).message).toBe("");
  });
});

describe("isAnnouncedGlobally", () => {
  it("claims the failures the app shell already puts on screen", () => {
    // A dropped connection and an expired session each raise one dialog centrally;
    // a toast saying the same thing would be the same news twice.
    expect(isAnnouncedGlobally(offline())).toBe(true);
    expect(isAnnouncedGlobally(failure(401, {}, "/api/indents"))).toBe(true);
    expect(isAnnouncedGlobally(new axios.CanceledError("canceled"))).toBe(true);
  });

  it("leaves everything else to the screen that asked", () => {
    expect(isAnnouncedGlobally(failure(403))).toBe(false);
    expect(isAnnouncedGlobally(failure(422))).toBe(false);
    expect(isAnnouncedGlobally(failure(500))).toBe(false);
    // A rejected sign-in is the login form's to show, inline, next to the fields.
    expect(isAnnouncedGlobally(failure(401, {}, "/api/auth/login"))).toBe(false);
  });
});

describe("claiming a failure", () => {
  it("lets the surface showing it inline stop a second announcement", () => {
    const refused = failure(422, { error: "Indent must have at least one item" });
    expect(isErrorClaimed(refused)).toBe(false);

    // What <ErrorBanner> does when it renders this one next to the form.
    claimError(refused);

    expect(isErrorClaimed(refused)).toBe(true);
    // Per failure, not per screen: the next refusal is a different object and is
    // announced normally.
    expect(isErrorClaimed(failure(422))).toBe(false);
  });
});
