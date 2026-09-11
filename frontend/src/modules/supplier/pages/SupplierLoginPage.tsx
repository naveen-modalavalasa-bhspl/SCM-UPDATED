import { useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useMutation } from "@tanstack/react-query";
import { Button, Card, ErrorBanner, Field, Input } from "@/shared/components";
import { setVendorPortal, setVendorToken } from "@/shared/api/client";
import { supplierApi } from "@/modules/procurement/api";

/**
 * The vendor's door. Separate from `/login` on purpose — a supplier is not an
 * employee, their token is stored under its own key, and neither session evicts
 * the other.
 */
export function SupplierLoginPage() {
  const nav = useNavigate();
  const [searchParams] = useSearchParams();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");

  const signIn = useMutation({
    mutationFn: () => supplierApi.login(username, password),
    onSuccess: (token) => {
      setVendorToken(token.access_token);
      // Same account can hold both doors open; the last one used is the one the
      // shared screens come back to.
      setVendorPortal("supplier");
      // A vendor still on the shared default sees nothing but the change form.
      const next = searchParams.get("next");
      const destination = next?.startsWith("/supplier/") ? next : "/supplier/rfqs";
      nav(token.must_change_password ? "/supplier/password" : destination, {
        replace: true,
      });
    },
  });

  return (
    <div className="flex min-h-screen items-center justify-center bg-surface-1 px-4">
      <Card className="w-full max-w-sm space-y-5 p-6">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-brand">
            Supplier Portal
          </p>
          <h1 className="mt-1 font-display text-2xl font-bold text-ink">Sign in</h1>
          <p className="mt-1 text-sm text-muted">
            Use the username and password your buyer gave you.
          </p>
        </div>

        <ErrorBanner error={signIn.error} />

        <form
          className="space-y-4"
          onSubmit={(e) => { e.preventDefault(); signIn.mutate(); }}
        >
          <Field label="Username">
            <Input
              value={username}
              autoComplete="username"
              onChange={(e) => setUsername(e.target.value)}
            />
          </Field>
          <Field label="Password">
            <Input
              type="password"
              value={password}
              autoComplete="current-password"
              onChange={(e) => setPassword(e.target.value)}
            />
          </Field>
          <Button
            type="submit"
            className="w-full"
            disabled={signIn.isPending || !username || !password}
          >
            {signIn.isPending ? "Signing in…" : "Sign in"}
          </Button>
        </form>
      </Card>
    </div>
  );
}
