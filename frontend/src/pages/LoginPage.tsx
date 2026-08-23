import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ArrowRight, Eye, EyeOff } from "lucide-react";
import { Input, Button } from "@heroui/react";
import { useAuth } from "@/shared/auth/AuthContext";
import loginHero from "@/assets/login-hero.png";

export function LoginPage() {
  const { login } = useAuth();
  const nav = useNavigate();
  const [username, setUsername] = useState("HR-EMP-");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showPassword, setShowPassword] = useState(false);

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
    <div className="flex min-h-dvh flex-col lg:flex-row">
      {/* Left — brand artwork */}
      <div className="flex items-center justify-center bg-white p-4 sm:p-6 lg:w-1/2 lg:p-10">
        <img
          src={loginHero}
          alt="SCM — procurement, inventory, warehouse, logistics"
          className="max-h-[30vh] w-auto max-w-full object-contain lg:max-h-[85vh] lg:w-full"
        />
      </div>

      {/* Right — sign in */}
      <div className="flex flex-1 items-center justify-center px-4 py-8 sm:px-8 lg:w-1/2">
        <div className="w-full max-w-md">
          <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-brand">
            Welcome back
          </div>
          <h1 className="mt-1 font-display text-2xl font-bold text-ink sm:text-3xl">Sign in</h1>
          <p className="mt-1 text-sm text-muted">One thread from indent to stock.</p>

          <form onSubmit={submit} className="mt-6 flex flex-col gap-4">
            <Input
              label="Employee ID"
              variant="bordered"
              radius="md"
              value={username}
              onValueChange={setUsername}
              autoFocus
              autoComplete="username"
              inputMode="text"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck="false"
              placeholder="Enter your employee ID"
            />
            {/* aria-label as well as label: HeroUI floats the label into the field
                until there is a value, and a screen reader landing on an empty
                password box was told nothing at all about what it was. */}
            <Input
              label="Password"
              aria-label="Password"
              type={showPassword ? "text" : "password"}
              variant="bordered"
              radius="md"
              value={password}
              onValueChange={setPassword}
              autoComplete="current-password"
              placeholder="Enter your password"
              endContent={
                <button
                  type="button"
                  onClick={() => setShowPassword((v) => !v)}
                  aria-label={showPassword ? "Hide password" : "Show password"}
                  title={showPassword ? "Hide password" : "Show password"}
                  className="text-muted transition-colors hover:text-ink focus:outline-none"
                >
                  {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              }
            />

            {/* Under the password box, where somebody looks the moment the one they
                typed did not work. */}
            <div className="-mt-1 flex justify-end">
              <Link
                to="/forgot-password"
                className="rounded text-sm font-medium text-brand transition-colors hover:text-brand-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30"
              >
                Forgot password?
              </Link>
            </div>

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
        </div>
      </div>
    </div>
  );
}
