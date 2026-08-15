import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation } from "@tanstack/react-query";
import { Button, Card, ErrorBanner, Field, Input, useToast } from "@/shared/components";
import { supplierApi } from "@/modules/procurement/api";

const DEFAULT_PASSWORD = "Bavya@123";

/** Where a vendor lands on their first sign-in. The backend refuses to accept the
 *  shared default as a new password, so this cannot be no-opped past. */
export function SupplierPasswordPage() {
  const nav = useNavigate();
  const toast = useToast();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [problem, setProblem] = useState<string | null>(null);

  const change = useMutation({
    mutationFn: () => supplierApi.changePassword(current, next),
    onSuccess: () => {
      toast.success("Password changed");
      nav("/supplier/rfqs", { replace: true });
    },
  });

  const submit = () => {
    if (next.length < 8) {
      setProblem("Use at least 8 characters.");
      return;
    }
    if (next !== confirm) {
      setProblem("The two new passwords do not match.");
      return;
    }
    if (next === DEFAULT_PASSWORD) {
      setProblem("Choose something other than the password you were given.");
      return;
    }
    setProblem(null);
    change.mutate();
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-surface-1 px-4">
      <Card className="w-full max-w-sm space-y-5 p-6">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-brand">
            Supplier Portal
          </p>
          <h1 className="mt-1 font-display text-2xl font-bold text-ink">
            Choose a password
          </h1>
          <p className="mt-1 text-sm text-muted">
            Everyone starts on the same one, so it has to be replaced before you go on.
          </p>
        </div>

        <ErrorBanner error={change.error} />
        {problem && <ErrorBanner error={problem} />}

        <form
          className="space-y-4"
          onSubmit={(e) => { e.preventDefault(); submit(); }}
        >
          <Field label="Current password">
            <Input
              type="password"
              value={current}
              autoComplete="current-password"
              onChange={(e) => setCurrent(e.target.value)}
            />
          </Field>
          <Field label="New password" hint="At least 8 characters.">
            <Input
              type="password"
              value={next}
              autoComplete="new-password"
              onChange={(e) => setNext(e.target.value)}
            />
          </Field>
          <Field label="New password again">
            <Input
              type="password"
              value={confirm}
              autoComplete="new-password"
              onChange={(e) => setConfirm(e.target.value)}
            />
          </Field>
          <Button type="submit" className="w-full" disabled={change.isPending}>
            {change.isPending ? "Saving…" : "Save and continue"}
          </Button>
        </form>
      </Card>
    </div>
  );
}
