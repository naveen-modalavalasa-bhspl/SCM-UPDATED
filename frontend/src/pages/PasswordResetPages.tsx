import { useId, useState, type FormEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import {
  AlertTriangle, ArrowLeft, ArrowRight, CheckCircle2, Eye, EyeOff, Loader2, MailCheck,
} from "lucide-react";
import { api } from "@/shared/api/client";
import {
  AuthShell, authField, authHint, authLabel, authLink, authSubmit,
} from "./AuthShell";

/**
 * The two halves of "forgot password", on the same shell as the sign-in page —
 * `AuthShell`, which is where the plate, the thread and the field styling now live.
 * They used to carry a second shell of their own (a light plate, HeroUI inputs, the
 * flat hero image), so pressing "Forgot password?" on the dark sign-in plate landed
 * somewhere that looked like a different product. Nothing here styles a control
 * itself; every class comes from the shell.
 *
 * Both are UNAUTHENTICATED by necessity — somebody who cannot sign in is the only
 * caller either one has. What makes that safe is on the server (see
 * `platform/mail/service.request_reset`): the request endpoint answers 204 whatever
 * happens, so an unknown address, a disabled employee and a mailbox that refused the
 * message are indistinguishable from success.
 *
 * This screen has to honour that. `Forgot` shows the SAME confirmation every time and
 * never surfaces an error from the request — a form that said "no such account" would
 * hand back exactly the account-enumeration oracle the endpoint was written to avoid,
 * from the other side.
 */

function BackToSignIn() {
  return (
    <Link to="/login" className={`${authLink} mt-8 inline-flex items-center gap-1.5`}>
      <ArrowLeft className="h-4 w-4" /> Back to sign in
    </Link>
  );
}

/** A notice on the plate. `tone` only moves the icon's colour: on this ground a solid
 *  pastel block reads as a sticker pasted onto the panel, so the card itself is the
 *  same tinted glass whatever it is saying. */
function PlateNote({ tone, icon: Icon, children }: {
  tone: "ok" | "bad";
  icon: typeof MailCheck;
  children: React.ReactNode;
}) {
  return (
    <div className="plate-note mt-6 flex items-start gap-3 rounded-xl p-4">
      <Icon
        className="mt-0.5 h-5 w-5 shrink-0"
        style={{ color: tone === "ok" ? "var(--plate-ok)" : "var(--plate-bad)" }}
      />
      <div className="text-[13.5px] leading-relaxed text-[var(--plate-muted)]">
        {children}
      </div>
    </div>
  );
}

/* --------------------------------------------------------------------------- */
/*  Ask for a link                                                             */
/* --------------------------------------------------------------------------- */

export function ForgotPasswordPage() {
  const [empCode, setEmpCode] = useState("HR-EMP-");
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const uid = useId();

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      // The emp code is what names the ACCOUNT; the address is only where the link
      // should go, and is not trusted until an admin confirms it (see
      // `platform/mail/service.request_reset`). HCM serves no employee email, so
      // there is nothing to identify an account by on its own.
      await api.post("/api/auth/forgot-password", { emp_code: empCode, email });
    } catch {
      // Swallowed ON PURPOSE, and this is the security of the feature rather than
      // sloppiness. The endpoint already answers 204 for an unknown address; if this
      // screen rendered a failure for anything else — a 422 on a malformed address,
      // a network blip — the difference would still be readable, and a stranger could
      // learn which addresses are real by watching which ones error.
    } finally {
      setBusy(false);
      setSent(true);
    }
  }

  if (sent) {
    return (
      <AuthShell
        eyebrow="Password reset"
        title="Check your inbox"
        subtitle="If that address belongs to an account, a reset link is on its way."
      >
        <PlateNote tone="ok" icon={MailCheck}>
          <p className="font-semibold text-[var(--plate-ink)]">
            Your request for {email} is in
          </p>
          {/* Deliberately does NOT promise a mail is on its way. The first time an
              address is used for an account it waits for an administrator to
              confirm it is really yours, and saying "sent" would be a lie for that
              case — but the wording cannot reveal WHICH case this was either, or it
              becomes a way to test whether an address is already on an account. */}
          <p className="mt-2">
            If it is already the address on your account, a link is on its way — it
            works once and stops working after 30 minutes. The first time you use a
            new address, your administrator confirms it belongs to you before the
            link goes out.
          </p>
          <p className="mt-2">
            If nothing arrives, check the spam folder, then ask your administrator.
          </p>
        </PlateNote>
        <BackToSignIn />
      </AuthShell>
    );
  }

  return (
    <AuthShell
      eyebrow="Password reset"
      title="Forgot your password?"
      subtitle="Enter your employee code and the work email your link should go to."
    >
      <form onSubmit={submit} className="mt-9 flex flex-col gap-5">
        <div>
          <label htmlFor={`${uid}-code`} className={authLabel}>Employee code</label>
          <input
            id={`${uid}-code`}
            /* Mono for the same reason sign-in uses it: HR-EMP-00417 reads and
               checks digit by digit, and a proportional face makes 1/l and 0/O the
               reader's problem. */
            className={`${authField} font-mono tracking-[0.04em]`}
            value={empCode}
            onChange={(e) => setEmpCode(e.target.value)}
            autoFocus
            autoComplete="username"
            autoCapitalize="characters"
            autoCorrect="off"
            spellCheck={false}
            placeholder="HR-EMP-00000"
            required
          />
          <p className={authHint}>The same code you sign in with.</p>
        </div>

        <div>
          <label htmlFor={`${uid}-mail`} className={authLabel}>Work email</label>
          <input
            id={`${uid}-mail`}
            className={authField}
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="email"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            placeholder="you@company.com"
            required
          />
          <p className={authHint}>
            Used the first time? Your administrator confirms it is yours before the
            link is sent.
          </p>
        </div>

        <button
          type="submit"
          disabled={busy || !empCode.trim() || !email.trim()}
          className={authSubmit}
        >
          {busy ? (
            <span className="flex items-center gap-2">
              <Loader2 className="h-4 w-4 animate-spin" /> Sending
            </span>
          ) : (
            <span className="flex items-center gap-2">
              Send reset link <ArrowRight className="h-4 w-4" />
            </span>
          )}
        </button>
      </form>
      <BackToSignIn />
    </AuthShell>
  );
}

/* --------------------------------------------------------------------------- */
/*  Spend the link                                                             */
/* --------------------------------------------------------------------------- */

export function ResetPasswordPage() {
  const [params] = useSearchParams();
  const nav = useNavigate();
  const token = params.get("token") ?? "";

  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const uid = useId();

  // Checked here as well as on the server. Not a security boundary — the server is —
  // but a person choosing a password should be told the rule before they submit.
  const tooShort = password.length > 0 && password.length < 8;
  const mismatch = confirm.length > 0 && confirm !== password;
  const ready = password.length >= 8 && confirm === password && Boolean(token);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post("/api/auth/reset-password", { token, new_password: password });
      setDone(true);
    } catch (err) {
      // Shown in full, unlike the request step: by now the caller is holding a link
      // that was mailed to them, so "this link has expired" tells them what to do
      // next and reveals nothing about anybody else's account.
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (!token) {
    return (
      <AuthShell
        eyebrow="Password reset"
        title="That link is incomplete"
        subtitle="Open the link from your email exactly as it was sent."
      >
        <PlateNote tone="bad" icon={AlertTriangle}>
          The reset link is missing its token. Ask for a new one and open it directly
          from the message rather than retyping it.
        </PlateNote>
        <Link
          to="/forgot-password"
          className={`${authLink} mt-8 inline-flex items-center gap-1.5`}
        >
          Ask for a new link <ArrowRight className="h-4 w-4" />
        </Link>
      </AuthShell>
    );
  }

  if (done) {
    return (
      <AuthShell
        eyebrow="Password reset"
        title="Password changed"
        subtitle="You can sign in with your new password now."
      >
        <PlateNote tone="ok" icon={CheckCircle2}>
          That link has now been used and will not work again.
        </PlateNote>
        <button type="button" onClick={() => nav("/login")} className={`${authSubmit} mt-6`}>
          <span className="flex items-center gap-2">
            Go to sign in <ArrowRight className="h-4 w-4" />
          </span>
        </button>
      </AuthShell>
    );
  }

  const eye = (
    <button
      type="button"
      onClick={() => setShow((v) => !v)}
      aria-label={show ? "Hide password" : "Show password"}
      className="login-link absolute inset-y-0 right-0 grid w-12 place-items-center rounded-r-lg text-[var(--plate-faint)] transition-colors hover:text-[var(--plate-ink)]"
    >
      {show ? <EyeOff className="h-[18px] w-[18px]" /> : <Eye className="h-[18px] w-[18px]" />}
    </button>
  );

  return (
    <AuthShell
      eyebrow="Password reset"
      title="Choose a new password"
      subtitle="At least 8 characters. You will use it the next time you sign in."
    >
      <form onSubmit={submit} className="mt-9 flex flex-col gap-5">
        <div>
          <label htmlFor={`${uid}-new`} className={authLabel}>New password</label>
          <div className="relative">
            <input
              id={`${uid}-new`}
              className={`${authField} pr-12`}
              type={show ? "text" : "password"}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoFocus
              autoComplete="new-password"
              aria-invalid={tooShort}
              aria-describedby={tooShort ? `${uid}-new-err` : undefined}
            />
            {eye}
          </div>
          {tooShort && (
            <p id={`${uid}-new-err`} className={authHint} style={{ color: "var(--plate-bad)" }}>
              Use at least 8 characters.
            </p>
          )}
        </div>

        <div>
          <label htmlFor={`${uid}-confirm`} className={authLabel}>
            Confirm new password
          </label>
          <div className="relative">
            <input
              id={`${uid}-confirm`}
              className={`${authField} pr-12`}
              type={show ? "text" : "password"}
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              autoComplete="new-password"
              aria-invalid={mismatch}
              aria-describedby={mismatch ? `${uid}-confirm-err` : undefined}
            />
            {eye}
          </div>
          {mismatch && (
            <p id={`${uid}-confirm-err`} className={authHint} style={{ color: "var(--plate-bad)" }}>
              The two passwords do not match.
            </p>
          )}
        </div>

        {error && (
          <PlateNote tone="bad" icon={AlertTriangle}>{error}</PlateNote>
        )}

        <button type="submit" disabled={busy || !ready} className={authSubmit}>
          {busy ? (
            <span className="flex items-center gap-2">
              <Loader2 className="h-4 w-4 animate-spin" /> Saving
            </span>
          ) : (
            <span className="flex items-center gap-2">
              Set new password <ArrowRight className="h-4 w-4" />
            </span>
          )}
        </button>
      </form>
      <BackToSignIn />
    </AuthShell>
  );
}
