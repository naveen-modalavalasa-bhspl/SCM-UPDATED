/**
 * Bavya SSO, the browser half: the Director arrives from bhsdb.in already signed in.
 *
 * bhsdb.in opens SCM at `/#bavya_ticket=<pass>`, a one-time pass that lives 60 seconds.
 * It rides in the fragment because a fragment never reaches a server or proxy log, nor
 * a Referer header. `main.tsx` takes it out of the address before the router mounts,
 * posts it to `/api/auth/bavya-sso`, and the answer is exactly what `/api/auth/login`
 * answers. The token goes where `AuthContext.login` puts it, so the app then mounts
 * signed in, exactly as it does on a reload after a password sign-in.
 *
 * `fetch` rather than the shared axios client on purpose: that client's 401 handler
 * clears the stored token and jumps to /login, which would throw away a session this
 * browser already has and hide the reason the pass was refused.
 */

export const BAVYA_SSO_EXPIRED =
  "This sign-in link has expired. Open the app again from bhsdb.in.";
export const BHSDB_LOGINS_URL = "https://bhsdb.in/logins";

const PREFIX = "#bavya_ticket=";
/** A compact JWT: three base64url parts. Anything else is not a pass. */
const PASS = /^[\w-]+\.[\w-]+\.[\w-]+$/;

/** The pass in the address, or null when there is none. The address is wiped at
 *  once, so Back and Refresh cannot replay it and nothing later can log it. A
 *  malformed pass is still wiped, and comes back as "" so the caller says so rather
 *  than showing the login form. */
export function takeBavyaTicket(): string | null {
  const { hash, pathname, search } = window.location;
  if (!hash.startsWith(PREFIX)) return null;
  window.history.replaceState(window.history.state, "", pathname + search);
  const ticket = hash.slice(PREFIX.length);
  return PASS.test(ticket) ? ticket : "";
}

/** Exchange the pass for the app's own token. Resolves to null when signed in, or
 *  to the sentence to show when not. A refused pass leaves any session this browser
 *  already holds exactly as it was. */
export async function signInWithBavyaTicket(
  ticket: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
  if (!ticket) return BAVYA_SSO_EXPIRED;
  let res: Response;
  try {
    res = await fetchImpl(`${import.meta.env.VITE_API_URL || ""}/api/auth/bavya-sso`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ticket }),
      cache: "no-store",
    });
  } catch {
    return BAVYA_SSO_EXPIRED;
  }
  const data = await res.json().catch(() => null);
  if (res.ok && typeof data?.access_token === "string" && data.access_token) {
    localStorage.setItem("token", data.access_token);
    return null;
  }
  // The server explains its two refusals (an expired or used pass; no account here)
  // in the sentences bhsdb.in's other apps use. Anything else — a 5xx, a proxy's
  // error page — gets the "open it again" sentence.
  if ((res.status === 401 || res.status === 403) && typeof data?.detail === "string") {
    return data.detail;
  }
  return BAVYA_SSO_EXPIRED;
}
