import { useId, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Eye, EyeOff, Loader2 } from "lucide-react";
import { Alert } from "@/shared/components";
import { useAuth } from "@/shared/auth/AuthContext";
import { BrandOrbit } from "./BrandOrbit";

/**
 * The sign-in screen.
 *
 * The page IS the brand sweep, spanned across the viewport: the warm end
 * (`--grad-1`, amber) is the ground the artwork stands on, the deep end
 * (`--grad-4`, violet) is the plate the form sits in, and the sweep itself runs
 * as one unbroken thread down the plate's leading edge — which is the product's
 * own sentence, "one thread from indent to stock", drawn rather than said.
 *
 * Boldness is spent in one place, the plate. Everything around it — the fields,
 * the ground, the chain at the foot — is deliberately quiet, so there is one
 * thing to look at rather than five competing.
 *
 * The controls are hand-built rather than HeroUI's. A dark island inside a
 * light-themed app cannot be reached by the theme's tokens, and dressing
 * HeroUI's inputs down to this palette costs more than owning forty lines of
 * input. Everything the platform gives for free is kept: real `<label for>`,
 * autofill hints, a visible focus ring, `aria-describedby` to the error.
 *
 * The failure message is still the shared `Alert` — a rejected sign-in should
 * look like every other failure in the app, and the sentence itself comes from
 * the one translation in `shared/api/errors.ts`, which is deliberately the same
 * whether the employee ID is unknown, retired, or simply typed with the wrong
 * password, so the form never confirms that an account exists.
 */

/** The document chain the system exists to keep. Stated here because a new
 *  employee's first screen is a fair place to say what they are signing into,
 *  and because it makes the tagline above it concrete. */
const CHAIN = ["Indent", "PO", "GRN", "Stock", "Issue"];


export function LoginPage() {
  const { login } = useAuth();
  const nav = useNavigate();
  const [username, setUsername] = useState("HR-EMP-");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const uid = useId();
  const errorId = `${uid}-error`;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(username, password);
      nav("/");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const field =
    "h-12 w-full rounded-lg border border-[var(--plate-line)] bg-[var(--plate-field)] px-4 " +
    "text-[15px] text-[var(--plate-ink)] placeholder:text-[var(--plate-faint)] " +
    "outline-none transition-[border-color,box-shadow] duration-200 " +
    "hover:border-[var(--plate-line-strong)] " +
    "focus:border-[var(--plate-focus)] focus:shadow-[0_0_0_3px_var(--plate-ring)]";

  return (
    <div className="login-page flex min-h-dvh flex-col lg:flex-row">
      <style>{LOGIN_CSS}</style>

      {/* The warm end of the sweep. The artwork is already loud, so the ground
          under it stays flat and gives it room rather than competing. */}
      <section className="login-ground flex items-center justify-center px-6 py-10 lg:w-1/2 lg:flex-none lg:px-14 lg:py-16">
        <BrandOrbit className="login-art" />
      </section>

      {/* The deep end of the sweep. */}
      <section className="login-plate relative flex flex-1 items-center px-6 py-12 sm:px-10 lg:w-1/2 lg:flex-none lg:px-16">
        {/* The thread: one unbroken run of the brand sweep along the plate's
            leading edge — the top edge once the columns stack. */}
        <span aria-hidden className="login-thread" />

        <div className="login-stack relative w-full max-w-[26rem] lg:mx-auto">
          <h1 className="login-in-1 font-display text-[2.75rem] font-bold leading-[0.95] tracking-[-0.035em] text-[var(--plate-ink)] sm:text-[3.25rem]">
            Sign in
          </h1>
          <p className="login-in-2 mt-3 text-[15px] leading-relaxed text-[var(--plate-muted)]">
            One thread from indent to stock.
          </p>

          <form onSubmit={submit} className="login-in-3 mt-9 flex flex-col gap-5">
            <div>
              <label
                htmlFor={`${uid}-user`}
                className="mb-2 block text-[13px] font-medium text-[var(--plate-muted)]"
              >
                Employee ID
              </label>
              <input
                id={`${uid}-user`}
                /* Mono here because the value genuinely is a code — HR-EMP-00417
                   reads and checks digit by digit, and a proportional face makes
                   1/l and 0/O the reader's problem. */
                className={`${field} font-mono tracking-[0.04em]`}
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                autoFocus
                autoComplete="username"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                placeholder="HR-EMP-00000"
                aria-describedby={error ? errorId : undefined}
              />
            </div>

            <div>
              <div className="mb-2 flex items-baseline justify-between gap-4">
                <label
                  htmlFor={`${uid}-pass`}
                  className="text-[13px] font-medium text-[var(--plate-muted)]"
                >
                  Password
                </label>
                {/* Beside the box it belongs to, which is where somebody looks
                    the moment the password they typed did not work. */}
                <Link
                  to="/forgot-password"
                  className="login-link rounded text-[13px] font-medium text-[var(--plate-muted)] transition-colors hover:text-[var(--plate-ink)]"
                >
                  Forgot password?
                </Link>
              </div>
              <div className="relative">
                <input
                  id={`${uid}-pass`}
                  className={`${field} pr-12`}
                  type={showPassword ? "text" : "password"}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="current-password"
                  placeholder="Enter your password"
                  aria-describedby={error ? errorId : undefined}
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((v) => !v)}
                  aria-label={showPassword ? "Hide password" : "Show password"}
                  className="login-link absolute inset-y-0 right-0 grid w-12 place-items-center rounded-r-lg text-[var(--plate-faint)] transition-colors hover:text-[var(--plate-ink)]"
                >
                  {showPassword ? <EyeOff className="h-[18px] w-[18px]" /> : <Eye className="h-[18px] w-[18px]" />}
                </button>
              </div>
            </div>

            {error && (
              <div id={errorId}>
                <Alert tone="danger" title={error} />
              </div>
            )}

            <button
              type="submit"
              disabled={busy}
              className="login-submit login-link mt-1 grid h-12 w-full place-items-center rounded-lg text-[15px] font-semibold text-white disabled:cursor-not-allowed"
            >
              {busy ? (
                <span className="flex items-center gap-2">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Signing in
                </span>
              ) : (
                "Sign in"
              )}
            </button>
          </form>

          {/* What the thread actually threads. Each document points back at the
              one before it, which is the whole shape of the system. */}
          <ol className="login-in-4 login-chain mt-12 flex items-center text-[11px]">
            {CHAIN.map((step, i) => (
              <li
                key={step}
                className="flex flex-1 items-center last:flex-none"
                style={{ "--i": i } as React.CSSProperties}
              >
                <span className="login-chain-step whitespace-nowrap">{step}</span>
                {i < CHAIN.length - 1 && (
                  <span aria-hidden className="login-chain-link mx-2 h-px flex-1" />
                )}
              </li>
            ))}
          </ol>
        </div>
      </section>
    </div>
  );
}

/* Scoped to this screen on purpose: the plate is a dark island inside a
   light-themed app, so its palette cannot come from the app's tokens without
   dragging the whole theme with it. The stops it is built from ARE the app's
   though — `--grad-1`..`--grad-4`, the Bavya sweep — so the two never drift. */
const LOGIN_CSS = `
.login-page {
  /* Deep petrol, not a tinted black.
     The violet this started as was the sweep's own last stop, and that was the
     problem: rendered dark enough to sit type on, it stopped reading as a colour
     at all and became the near-black every dark login already is. Teal is the
     COMPLEMENT of the sweep's warm end, so amber, orange and crimson all reach
     their strongest against it — the button, the thread and the SCM mark are
     lit by the ground instead of fighting it. */
  --plate-bg-top: #12454F;
  --plate-bg-bot: #0B2E38;
  --plate-ink: #F2F9F9;
  --plate-muted: #A6C2C7;
  --plate-faint: #71969D;
  --plate-field: #FFFFFF0A;
  --plate-line: #FFFFFF20;
  --plate-line-strong: #FFFFFF36;
  /* Focus and its ring come off the warm end for the same reason. */
  --plate-focus: #FFB37A;
  --plate-ring: #FB8B0033;
}
.login-ground {
  background: #FBF8F4;
}
.login-plate {
  background:
    radial-gradient(120% 70% at 12% 8%, #FB8B001F 0%, transparent 62%),
    linear-gradient(168deg, var(--plate-bg-top) 0%, var(--plate-bg-bot) 100%);
}
/* The thread. Horizontal across the top while the columns are stacked, vertical
   down the leading edge once they sit side by side. */
.login-thread {
  position: absolute;
  inset: 0 0 auto 0;
  height: 4px;
  background: linear-gradient(90deg, var(--grad-4) 0%, var(--grad-3) 35%, var(--grad-2) 70%, var(--grad-1) 100%);
  box-shadow: 0 0 24px -2px #CC004C99;
  transform-origin: left center;
}
@media (min-width: 1024px) {
  .login-thread {
    inset: 0 auto 0 0;
    width: 4px;
    height: auto;
    /* Violet at the foot, where it meets the deepest part of the plate, rising
       through crimson to amber at the head — so the thread is brightest exactly
       where the eye enters the panel and the heading sits. */
    background: linear-gradient(180deg, var(--grad-1) 0%, var(--grad-2) 26%, var(--grad-3) 62%, var(--grad-4) 100%);
    box-shadow: 0 0 32px -4px #CC004CAA;
    transform-origin: center top;
  }
}
.login-submit {
  background-image: linear-gradient(96deg, var(--grad-2) 0%, var(--grad-3) 58%, var(--grad-4) 130%);
  background-size: 160% 100%;
  background-position: 0% 0%;
  transition: background-position .45s ease, box-shadow .25s ease, opacity .2s ease;
  box-shadow: 0 1px 0 #FFFFFF26 inset, 0 8px 24px -12px var(--grad-3);
}
.login-submit:hover:not(:disabled) { background-position: 34% 0%; }
.login-submit:active:not(:disabled) { box-shadow: 0 1px 0 #FFFFFF14 inset; }
.login-submit:disabled { opacity: .65; }
/* One ring shape for every interactive thing on the plate. */
.login-link:focus-visible,
.login-page input:focus-visible {
  outline: 2px solid var(--plate-focus);
  outline-offset: 2px;
}
.login-page input:focus-visible { outline-offset: 0; }
/* Chrome paints its own bright yellow over autofilled fields, which on this
   plate is the one thing that can break it. */
.login-page input:-webkit-autofill,
.login-page input:-webkit-autofill:focus {
  -webkit-text-fill-color: var(--plate-ink);
  -webkit-box-shadow: 0 0 0 100px #1E1430 inset;
  caret-color: var(--plate-ink);
}

/* One orchestrated arrival, on load, and nothing after it: the thread draws in,
   then the stack settles in four short beats. Hover states elsewhere stay still. */
@keyframes login-thread-in { from { transform: scaleX(0); } to { transform: scaleX(1); } }
@keyframes login-thread-in-v { from { transform: scaleY(0); } to { transform: scaleY(1); } }
@keyframes login-rise { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
@keyframes login-art-in { from { opacity: 0; transform: scale(.985); } to { opacity: 1; transform: none; } }

.login-thread { animation: login-thread-in .7s cubic-bezier(.2,.7,.3,1) both; }
@media (min-width: 1024px) {
  .login-thread { animation-name: login-thread-in-v; }
}
.login-art { animation: login-art-in .9s ease-out both; }
.login-in-1 { animation: login-rise .5s ease-out .10s both; }
.login-in-2 { animation: login-rise .5s ease-out .18s both; }
.login-in-3 { animation: login-rise .5s ease-out .26s both; }
.login-in-4 { animation: login-rise .5s ease-out .34s both; }

/* The chain, carrying a signal.
   Each link lights in turn and hands off to the next, so the eye follows one
   document through the whole flow rather than reading five static words. The
   signal is WHITE, not the brand sweep: the plate already runs that gradient
   twice, on the thread and on the button, and a third pass of it here read as
   clutter rather than emphasis. One
   beat per link plus two beats of rest, which is what stops it reading as a
   loading bar — a thing that never pauses is a thing that is waiting. */
.login-chain { --beat: .62s; --cycle: calc(var(--beat) * 9); }
.login-chain-step {
  color: var(--plate-faint);
  animation: chain-lit var(--cycle) linear infinite;
  animation-delay: calc(var(--i) * var(--beat));
}
@keyframes chain-lit {
  0%             { color: var(--plate-faint); }
  4%             { color: #FFFFFF; text-shadow: 0 0 16px #FFFFFF80; }
  14%            { color: #FFFFFF; text-shadow: 0 0 16px #FFFFFF80; }
  30%, 100%      { color: var(--plate-faint); text-shadow: none; }
}
/* The connector fills from the link just lit toward the next one, arriving as
   that one lights — the hand-off is the point, so it is timed half a beat in. */
.login-chain-link {
  position: relative;
  background: var(--plate-line);
  overflow: hidden;
}
.login-chain-link::after {
  content: "";
  position: absolute;
  inset: 0;
  background: linear-gradient(90deg, transparent 0%, #FFFFFF 45%, #FFFFFF 55%, transparent 100%);
  background-size: 260% 100%;
  background-position: 130% 0;
  opacity: 0;
  animation: chain-run var(--cycle) linear infinite;
  animation-delay: calc((var(--i) + .45) * var(--beat));
}
@keyframes chain-run {
  0%        { background-position: 130% 0; opacity: 0; }
  3%        { opacity: 1; }
  13%       { background-position: -30% 0; opacity: 1; }
  19%, 100% { background-position: -30% 0; opacity: 0; }
}

@media (prefers-reduced-motion: reduce) {
  .login-page *, .login-page *::before, .login-page *::after {
    animation: none !important;
    transition: none !important;
  }
}
`;
