import { describe, expect, it } from "vitest";
import { absoluteUrl, curlFor, incrementalHint, queryString } from "../snippets";

const BASE = "https://scm.example.internal";

describe("integration snippets", () => {
  it("builds the address from the browser's own origin, never a literal", () => {
    expect(absoluteUrl("/api/ext/v1/stock-on-hand", BASE))
      .toBe("https://scm.example.internal/api/ext/v1/stock-on-hand");
  });

  it("hands out a curl line that carries the header, not the key in the URL", () => {
    const line = curlFor({ url: "/api/ext/v1/stock-on-hand" }, {}, BASE);
    expect(line).toBe(
      'curl -H "X-API-Key: YOUR_API_KEY" "https://scm.example.internal/api/ext/v1/stock-on-hand"',
    );
    // A key in the query string ends up in every proxy log there is.
    expect(line).not.toContain("?api_key");
  });

  it("appends params and escapes them", () => {
    expect(queryString({ updated_since: "2026-08-01", search: "a b" }))
      .toBe("?updated_since=2026-08-01&search=a%20b");
    expect(queryString({ empty: "" })).toBe("");
    expect(queryString({})).toBe("");
  });

  it("says whether a dataset can be pulled incrementally", () => {
    expect(incrementalHint("updated_at")).toContain("updated_since");
    expect(incrementalHint(null)).toContain("pull it whole");
  });
});
