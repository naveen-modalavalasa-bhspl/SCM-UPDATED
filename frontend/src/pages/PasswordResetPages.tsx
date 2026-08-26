import { useState, type FormEvent, type ReactNode } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { ArrowLeft, ArrowRight, CheckCircle2, Eye, EyeOff, MailCheck } from "lucide-react";
import { Button, Input } from "@heroui/react";
import { api } from "@/shared/api/client";
import loginHero from "@/assets/login-hero.png";

/**
 * The two halves of "forgot password", on the same public shell as the sign-in page.
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

/** The shell both pages share with the sign-in screen, so the flow does not change
 *  shape halfway through. */
function AuthShell({ eyebrow, title, subtitle, children }: {
  eyebrow: string;
  title: string;
  subtitle: string;
  children: ReactNode;
}) {
  return (
    <div className="flex min-h-dvh flex-col lg:flex-row">
      <div className="flex items-center justify-center bg-white p-4 sm:p-6 lg:w-1/2 lg:p-10">
        <img
          src={loginHero}
          alt="SCM — procurement, inventory, warehouse, logistics"
          className="max-h-[30vh] w-auto max-w-full object-contain lg:max-h-[85vh] lg:w-full"
        />
      </div>
      <div className="flex flex-1 items-center justify-center px-4 py-8 sm:px-8 lg:w-1/2">
        <div className="w-full max-w-md">
          <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-brand">
            {eyebrow}
          </div>
          <h1 className="mt-1 font-display text-2xl font-bold text-ink sm:text-3xl">{title}</h1>
          <p className="mt-1 text-sm text-muted">{subtitle}</p>
          {children}
        </div>
      </div>
    </div>
  );
}

function BackToSignIn() {
  return (
    <Link
      to="/login"
      className="mt-6 inline-flex items-center gap-1.5 rounded text-sm font-semibold text-brand transition-colors hover:text-brand-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30"
    >
      <ArrowLeft className="h-4 w-4" /> Back to sign in
    </Link>
  );
}

/* --------------------------------------------------------------------------- */
/*  Ask for a link                                                             */
/* --------------------------------------------------------------------------- */

export function ForgotPasswordPage() {
  const [empCode, setEmpCode] = useState("");
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);

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
        <div className="mt-6 flex items-start gap-3 rounded-xl border border-line/70 bg-ok-bg/50 p-4">
          <MailCheck className="mt-0.5 h-5 w-5 shrink-0 text-ok" />
          <div className="text-sm text-body">
            <p className="font-semibold text-ink">Your request for {email} is in</p>
            {/* Deliberately does NOT promise a mail is on its way. The first time an
                address is used for an account it waits for an administrator to
                confirm it is really yours, and saying "sent" would be a lie for that
                case — but the wording cannot reveal WHICH case this was either, or it
                becomes a way to test whether an address is already on an account. */}
            <p className="mt-1 text-muted">
              If it is already the address on your account, a link is on its way — it
              works once and stops working after 30 minutes. The first time you use a
              new address, your administrator confirms it belongs to you before the
              link goes out.
            </p>
            <p className="mt-1 text-muted">
              If nothing arrives, check the spam folder, then ask your administrator.
            </p>
          </div>
        </div>
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
      <form onSubmit={submit} className="mt-6 flex flex-col gap-4">
        <Input
          label="Employee code"
          aria-label="Employee code"
          variant="bordered"
          radius="md"
          value={empCode}
          onValueChange={setEmpCode}
          autoFocus
          autoComplete="username"
          autoCapitalize="characters"
          autoCorrect="off"
          spellCheck="false"
          placeholder="HR-EMP-09561"
          description="The same code you sign in with."
          isRequired
        />
        <Input
          label="Work email"
          aria-label="Work email"
          type="email"
          variant="bordered"
          radius="md"
          value={email}
          onValueChange={setEmail}
          autoComplete="email"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck="false"
          placeholder="you@company.com"
          description="Used the first time? Your administrator confirms it is yours before the link is sent."
          isRequired
        />
        <Button
          type="submit"
          color="primary"
          radius="md"
          isLoading={busy}
          isDisabled={!empCode.trim() || !email.trim()}
          endContent={!busy && <ArrowRight className="h-4 w-4" />}
          className="mt-1 h-11 w-full font-semibold"
        >
          {busy ? "Sending…" : "Send reset link"}
        </Button>
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
        <div className="mt-6 rounded-xl bg-bad-bg px-4 py-3 text-sm font-medium text-bad">
          The reset link is missing its token. Ask for a new one and open it directly
          from the message rather than retyping it.
        </div>
        <Link
          to="/forgot-password"
          className="mt-6 inline-flex items-center gap-1.5 rounded text-sm font-semibold text-brand hover:text-brand-600"
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
        <div className="mt-6 flex items-start gap-3 rounded-xl border border-line/70 bg-ok-bg/50 p-4">
          <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-ok" />
          <p className="text-sm text-body">
            That link has now been used and will not work again.
          </p>
        </div>
        <Button
          color="primary"
          radius="md"
          onPress={() => nav("/login")}
          endContent={<ArrowRight className="h-4 w-4" />}
          className="mt-6 h-11 w-full font-semibold"
        >
          Go to sign in
        </Button>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      eyebrow="Password reset"
      title="Choose a new password"
      subtitle="At least 8 characters. You will use it the next time you sign in."
    >
      <form onSubmit={submit} className="mt-6 flex flex-col gap-4">
        <Input
          label="New password"
          aria-label="New password"
          type={show ? "text" : "password"}
          variant="bordered"
          radius="md"
          value={password}
          onValueChange={setPassword}
          autoFocus
          autoComplete="new-password"
          isInvalid={tooShort}
          errorMessage={tooShort ? "Use at least 8 characters." : undefined}
          endContent={
            <button
              type="button"
              onClick={() => setShow((v) => !v)}
              aria-label={show ? "Hide password" : "Show password"}
              className="text-muted transition-colors hover:text-ink focus:outline-none"
            >
              {show ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </button>
          }
        />
        <Input
          label="Confirm new password"
          aria-label="Confirm new password"
          type={show ? "text" : "password"}
          variant="bordered"
          radius="md"
          value={confirm}
          onValueChange={setConfirm}
          autoComplete="new-password"
          isInvalid={mismatch}
          errorMessage={mismatch ? "The two passwords do not match." : undefined}
        />

        {error && (
          <div className="rounded-xl bg-bad-bg px-3 py-2 text-sm font-medium text-bad">
            {error}
          </div>
        )}

        <Button
          type="submit"
          color="primary"
          radius="md"
          isLoading={busy}
          isDisabled={!ready}
          endContent={!busy && <ArrowRight className="h-4 w-4" />}
          className="mt-1 h-11 w-full font-semibold"
        >
          {busy ? "Saving…" : "Set new password"}
        </Button>
      </form>
      <BackToSignIn />
    </AuthShell>
  );
}
