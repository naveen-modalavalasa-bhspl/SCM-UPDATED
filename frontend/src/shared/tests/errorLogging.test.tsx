import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import {
  AppErrorBoundary,
  isChunkLoadError,
  shouldAutoReloadChunk,
} from "../errorLogging";

/**
 * Stale-chunk recovery: a redeploy renames every hashed chunk, so a tab
 * opened before the release throws "Failed to fetch dynamically imported
 * module" when it first visits a screen. That must reload once and read as a
 * friendly notice — never as the scary "Something went wrong" panel, and
 * never as a reload loop.
 */

const RELOAD_KEY = "scm-chunk-reload-at";
// The exact failure from the 2026-10-10 incident (indent journey page).
const STALE_CHUNK = new TypeError(
  "Failed to fetch dynamically imported module: http://103.174.161.68:8023/assets/HomePage-CHm2YYNA.js",
);

beforeEach(() => {
  sessionStorage.clear();
  vi.restoreAllMocks();
  // React logs every error a boundary catches; keep the suite output clean.
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("isChunkLoadError", () => {
  it("recognises the stale-chunk TypeError from the incident", () => {
    expect(isChunkLoadError(STALE_CHUNK)).toBe(true);
  });

  it("recognises the other bundler wordings for the same failure", () => {
    expect(isChunkLoadError(new Error("Loading chunk 42 failed."))).toBe(true);
    expect(
      isChunkLoadError(new Error("Importing a module script failed.")),
    ).toBe(true);
    const named = new Error("boom");
    named.name = "ChunkLoadError";
    expect(isChunkLoadError(named)).toBe(true);
  });

  it("does not mistake an ordinary render crash for a missing file", () => {
    expect(
      isChunkLoadError(
        new TypeError("Cannot read properties of undefined (reading 'map')"),
      ),
    ).toBe(false);
    expect(isChunkLoadError(new Error("Indent could not be submitted."))).toBe(
      false,
    );
    expect(isChunkLoadError(null)).toBe(false);
    expect(isChunkLoadError("Failed to fetch /api/indents")).toBe(false);
  });
});

describe("shouldAutoReloadChunk", () => {
  it("allows the first reload and refuses the immediate second", () => {
    expect(shouldAutoReloadChunk()).toBe(true);
    expect(shouldAutoReloadChunk()).toBe(false);
  });

  it("allows another reload after the cooldown, for a much later deploy", () => {
    const now = Date.now();
    sessionStorage.setItem(RELOAD_KEY, String(now - 11 * 60 * 1000));
    expect(shouldAutoReloadChunk(now)).toBe(true);
  });

  it("treats a corrupt stored value as no previous reload", () => {
    sessionStorage.setItem(RELOAD_KEY, "not-a-number");
    expect(shouldAutoReloadChunk()).toBe(true);
  });
});

let explode = true;

function Thrower({ error }: { error: Error }) {
  if (explode) throw error;
  return <div>Recovered screen</div>;
}

function explodeWith(error: Error) {
  explode = true;
  render(
    <AppErrorBoundary>
      <Thrower error={error} />
    </AppErrorBoundary>,
  );
}

describe("AppErrorBoundary stale-chunk path", () => {
  it("shows the friendly notice, not the scary panel, and spends the guard", () => {
    explodeWith(STALE_CHUNK);

    expect(
      screen.getByText("A new version is available"),
    ).toBeInTheDocument();
    expect(screen.queryByText("Something went wrong")).toBeNull();
    expect(screen.getByText("Refresh now")).toBeInTheDocument();
    // The automatic reload was attempted exactly once for this failure.
    expect(sessionStorage.getItem(RELOAD_KEY)).not.toBeNull();
  });

  it("shows the generic panel — and no auto-reload — for a real crash", () => {
    explodeWith(new TypeError("Cannot read properties of undefined"));

    expect(screen.getByText("Something went wrong")).toBeInTheDocument();
    expect(
      screen.queryByText("A new version is available"),
    ).toBeNull();
    expect(sessionStorage.getItem(RELOAD_KEY)).toBeNull();
  });

  it("retries the import without a reload when asked", () => {
    explodeWith(STALE_CHUNK);
    expect(
      screen.getByText("A new version is available"),
    ).toBeInTheDocument();

    explode = false;
    fireEvent.click(screen.getByText("Try again"));
    expect(screen.getByText("Recovered screen")).toBeInTheDocument();
  });
});
