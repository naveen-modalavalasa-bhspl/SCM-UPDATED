import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Truck } from "lucide-react";
import { Button, Card, ErrorBanner, Field, Input } from "@/shared/components";
import { api, setVendorPortal, setVendorToken } from "@/shared/api/client";

interface VendorToken {
  access_token: string;
  must_change_password?: boolean;
}

/**
 * The carrier's door.
 *
 * Same credentials as the supplier portal, because a carrier is a vendor — one
 * account, one password, one place their rate history lives. The separate door only
 * decides where they land: a transport provider signing in wants their shipments, not
 * an RFQ list.
 */
export function CarrierLoginPage() {
  const nav = useNavigate();
  const qc = useQueryClient();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");

  const signIn = useMutation({
    mutationFn: () => api.post<VendorToken>("/api/supplier/login",
      { username, password }).then((r) => r.data),
    onSuccess: (token) => {
      // Whoever was here before does not come with us. Sign-out clears this too, but
      // a tab that was simply left open and signed into as somebody else never ran it.
      qc.clear();
      setVendorToken(token.access_token);
      // They came in the carrier door: remember it, so the screens both portals share
      // send them back HERE and not to the supplier's RFQ list.
      setVendorPortal("carrier");
      // Still on the shared default? The change form is the only screen they get. It
      // lives on the supplier path because there is one of it, and it now returns to
      // whichever portal set the line above.
      nav(token.must_change_password ? "/supplier/password" : "/carrier/jobs", {
        replace: true,
      });
    },
  });

  return (
    <div className="flex min-h-screen items-center justify-center bg-surface-1 px-4">
      <Card className="w-full max-w-sm space-y-5 p-6">
        <div>
          <span className="mb-2 inline-flex h-10 w-10 items-center justify-center rounded-xl bg-brand/10">
            <Truck className="h-5 w-5 text-brand" />
          </span>
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-brand">
            Logistics Partner Portal
          </p>
          <h1 className="mt-1 font-display text-2xl font-bold text-ink">Sign in</h1>
          <p className="mt-1 text-sm text-muted">
            Quote for lanes, accept the jobs you win, and report them delivered.
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
