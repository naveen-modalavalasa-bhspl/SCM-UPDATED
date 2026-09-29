import { useId, useState, type FormEvent } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { Eye, EyeOff, Loader2 } from "lucide-react";
import { Alert } from "@/shared/components";
import { useAuth } from "@/shared/auth/AuthContext";
import { AuthShell, authField, authLabel, authLink, authSubmit } from "./AuthShell";

/**
 * The sign-in screen.
 *
 * The plate, the thread, the field styling and the arrival animation all live in
 * `AuthShell`, which "forgot password" and "choose a new password" render too — the
 * three are one flow and used to be two different-looking ones. What is left here is
 * only what is TRUE OF SIGNING IN: the two fields, the failure message, and the
 * document chain at the foot.
 *
 * The failure message is the shared `Alert` — a rejected sign-in should look like
 * every other failure in the app, and the sentence itself comes from the one
 * translation in `shared/api/errors.ts`, which is deliberately the same whether the
 * employee ID is unknown, retired, or simply typed with the wrong password, so the
 * form never confirms that an account exists.
 */

/** The document chain the system exists to keep. Stated here because a new
 *  employee's first screen is a fair place to say what they are signing into,
 *  and because it makes the tagline above it concrete. */
const CHAIN = ["Indent", "PO", "GRN", "Stock", "Issue"];

export function LoginPage() {
  const { login } = useAuth();
  const nav = useNavigate();
  const location = useLocation();
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
      const requested = new URLSearchParams(location.search).get("next");
      // Only return to an internal app route. This keeps a crafted login link from
      // becoming an open redirect while allowing a scanned label to survive sign-in.
      const next = requested?.startsWith("/") && !requested.startsWith("//")
        ? requested
        : "/";
      nav(next, { replace: true });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthShell
      title="Sign in"
      subtitle="One thread from indent to stock."
      foot={
        /* What the thread actually threads. Each document points back at the
           one before it, which is the whole shape of the system. */
        <ol className="login-chain mt-12 flex items-center text-[11px]">
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
      }
    >
      <form onSubmit={submit} className="mt-9 flex flex-col gap-5">
        <div>
          <label htmlFor={`${uid}-user`} className={authLabel}>Employee ID</label>
          <input
            id={`${uid}-user`}
            /* Mono here because the value genuinely is a code — HR-EMP-00417
               reads and checks digit by digit, and a proportional face makes
               1/l and 0/O the reader's problem. */
            className={`${authField} font-mono tracking-[0.04em]`}
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
            <Link to="/forgot-password" className={authLink}>
              Forgot password?
            </Link>
          </div>
          <div className="relative">
            <input
              id={`${uid}-pass`}
              className={`${authField} pr-12`}
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

        <button type="submit" disabled={busy} className={authSubmit}>
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
    </AuthShell>
  );
}
