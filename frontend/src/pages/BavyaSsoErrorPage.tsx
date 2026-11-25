import { BHSDB_LOGINS_URL } from "@/shared/auth/bavyaSso";
import { AuthShell, authLink, authSubmit } from "./AuthShell";

/**
 * Shown instead of the app when a pass from bhsdb.in is refused (see
 * `shared/auth/bavyaSso.ts`). On the sign-in plate, because it is a sign-in outcome,
 * but deliberately NOT the login form: the Director came from bhsdb.in and the way
 * on is to open SCM from there again. Rendered outside the router, so plain links.
 */
export function BavyaSsoErrorPage({ message }: { message: string }) {
  return (
    <AuthShell eyebrow="Sign-in link" title="Couldn't sign you in">
      <p role="alert" className="mt-3 text-[15px] leading-relaxed text-[var(--plate-muted)]">
        {message}
      </p>
      <div className="mt-8 flex flex-col gap-5">
        <a href={BHSDB_LOGINS_URL} className={authSubmit}>
          Back to bhsdb.in
        </a>
        <a href="/login" className={`${authLink} self-start`}>
          Sign in with a password instead
        </a>
      </div>
    </AuthShell>
  );
}
