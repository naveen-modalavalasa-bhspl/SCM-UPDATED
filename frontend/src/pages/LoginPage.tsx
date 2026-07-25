import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { Boxes, ArrowRight } from "lucide-react";
import { Card, CardBody, Input, Button } from "@heroui/react";
import { useAuth } from "@/shared/auth/AuthContext";

export function LoginPage() {
  const { login } = useAuth();
  const nav = useNavigate();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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

  return (
    <div className="grid min-h-full place-items-center px-4 py-10">
      <div className="w-full max-w-md">
        {/* Brand */}
        <div className="mb-6 flex flex-col items-center text-center">
          <span className="mb-3 grid h-14 w-14 place-items-center rounded-2xl bg-brand text-white shadow-lg shadow-brand/25">
            <Boxes className="h-7 w-7" strokeWidth={2.2} />
          </span>
          <h1 className="font-display text-2xl font-bold text-ink">
            SCM<span className="text-signal">·</span>ERP
          </h1>
          <p className="mt-1 text-sm text-muted">One thread from indent to stock.</p>
        </div>

        <Card shadow="sm" radius="lg" className="border border-line/70 bg-content1">
          <CardBody className="gap-4 p-6 sm:p-8">
            <div>
              <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-brand">Welcome back</div>
              <h2 className="mt-1 font-display text-xl font-bold text-ink">Sign in</h2>
            </div>

            <form onSubmit={submit} className="flex flex-col gap-4">
              <Input
                label="Employee ID"
                variant="bordered"
                radius="md"
                value={username}
                onValueChange={setUsername}
                autoFocus
                autoComplete="username"
                inputMode="numeric"
                placeholder="Enter your employee ID"
              />
              <Input
                label="Password"
                type="password"
                variant="bordered"
                radius="md"
                value={password}
                onValueChange={setPassword}
                autoComplete="current-password"
              />

              {error && (
                <div className="rounded-xl bg-bad-bg px-3 py-2 text-sm font-medium text-bad">{error}</div>
              )}

              <Button
                type="submit"
                color="primary"
                radius="md"
                isLoading={busy}
                endContent={!busy && <ArrowRight className="h-4 w-4" />}
                className="mt-1 h-11 w-full font-semibold"
              >
                {busy ? "Signing in…" : "Sign in"}
              </Button>
            </form>
          </CardBody>
        </Card>
      </div>
    </div>
  );
}
