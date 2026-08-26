import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Avatar, Chip, Spinner } from "@heroui/react";
import { LogOut, Monitor, Moon, Sun } from "lucide-react";
import { CardBody } from "@heroui/react";
import { api } from "@/shared/api/client";
import { useAuth } from "@/shared/auth/AuthContext";
import {
  Button, Card, ErrorBanner, Field, Input, PageHeader, StatusPill, useToast,
} from "@/shared/components";
import { fmtDate, fmtDateTime } from "@/shared/datetime";
import { getTheme, setTheme, THEME_OPTIONS, type ThemeChoice } from "@/shared/theme";

/** Everything `/api/auth/profile` returns. Read-only: hcm_* is a mirror. */
type ProfilePosition = {
  id: number;
  name: string;
  code: string | null;
  is_primary: boolean;
  is_active: boolean;
  department_id: number | null;
  department_name: string | null;
  office_id: number | null;
  office_name: string | null;
  level_id: number | null;
  level_name: string | null;
  role_id: number | null;
  role_name: string | null;
  job_name: string | null;
  project_id: number | null;
  project_name: string | null;
  parent_position_id: number | null;
  parent_position_name: string | null;
  valid_from: string | null;
  valid_to: string | null;
};

type Profile = {
  id: number;
  name: string;
  code: string | null;
  email: string | null;
  mobile: string | null;
  is_active: boolean;
  department_id: number | null;
  department_name: string | null;
  section_id: number | null;
  section_name: string | null;
  office: {
    id: number;
    name: string;
    code: string | null;
    office_type: string | null;
    address: string | null;
    city: string | null;
    state: string | null;
  } | null;
  project_id: number | null;
  project_name: string | null;
  synced_at: string | null;
  positions: ProfilePosition[];
  active_position_id: number | null;
  roles: { code: string; name: string | null }[];
  permissions: string[];
  warehouse_label: string;
  account: {
    last_login_at: string | null;
    must_change_password: boolean;
    is_locked: boolean;
    created_at: string | null;
  } | null;
};

const dash = "—";

const when = (value: string | null | undefined) => fmtDateTime(value, dash);

const day = (value: string | null | undefined) => fmtDate(value, dash);

/** One label/value pair. `value` falls back to an em dash so a blank row still reads. */
function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 border-b border-line/60 py-2.5 last:border-0 sm:flex-row sm:items-baseline sm:gap-4">
      <div className="text-xs font-medium uppercase tracking-wide text-muted sm:w-52 sm:shrink-0">
        {label}
      </div>
      <div className="break-words text-sm text-ink">{value || dash}</div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Card>
      <CardBody className="p-4 sm:p-5">
        <h2 className="mb-1 font-display text-base font-bold text-ink">{title}</h2>
        <div>{children}</div>
      </CardBody>
    </Card>
  );
}

const MIN_PASSWORD_LENGTH = 8;

/** The one thing on this screen that writes. Everything else is an HCM mirror and is
 *  read-only by rule; the local login secret is SCM's own, so its owner may replace
 *  it. No `<Can>` around it: the endpoint takes the subject from the token, so there
 *  is no permission code to gate — every login owns exactly one password, its own. */
function ChangePassword({ mustChange }: { mustChange: boolean }) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [problem, setProblem] = useState<string | null>(null);

  const change = useMutation({
    mutationFn: () => api.post("/api/auth/change-password", {
      current_password: current,
      new_password: next,
    }),
    onSuccess: () => {
      toast.success("Password changed");
      setCurrent("");
      setNext("");
      setConfirm("");
      setProblem(null);
      // `must_change_password` and nothing else moved — refetch rather than patch,
      // so the Account section cannot disagree with the server about it.
      queryClient.invalidateQueries({ queryKey: ["auth", "profile"] });
    },
  });

  const submit = () => {
    if (next.length < MIN_PASSWORD_LENGTH) {
      setProblem(`Use at least ${MIN_PASSWORD_LENGTH} characters.`);
      return;
    }
    if (next !== confirm) {
      setProblem("The two new passwords do not match.");
      return;
    }
    if (next === current) {
      setProblem("Choose something other than your current password.");
      return;
    }
    setProblem(null);
    change.mutate();
  };

  return (
    <Card>
      <CardBody className="p-4 sm:p-5">
        <h2 className="mb-1 font-display text-base font-bold text-ink">Change password</h2>
        <p className="mb-3 text-sm text-muted">
          {mustChange
            ? "You are still on the password you were issued. Replace it now."
            : "Only you can change this. Sign-ins elsewhere keep working until they expire."}
        </p>

        <ErrorBanner error={change.error} />
        {problem && <ErrorBanner error={problem} />}

        <form
          className="mt-3 grid max-w-xl gap-4 sm:grid-cols-2"
          onSubmit={(e) => { e.preventDefault(); submit(); }}
        >
          <div className="sm:col-span-2">
            <Field label="Current password">
              <Input
                type="password"
                value={current}
                autoComplete="current-password"
                onChange={(e) => setCurrent(e.target.value)}
              />
            </Field>
          </div>
          <Field label="New password" hint={`At least ${MIN_PASSWORD_LENGTH} characters.`}>
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
          <div className="sm:col-span-2">
            <Button type="submit" disabled={change.isPending}>
              {change.isPending ? "Saving…" : "Update password"}
            </Button>
          </div>
        </form>
      </CardBody>
    </Card>
  );
}


/**
 * Where this person's password-reset link is delivered.
 *
 * NEW 2026-08-26. HCM carries no email address for anybody — not on the employees
 * list, not on the detail record — so all 1,933 mirrored employees held NULL, and
 * "forgot password" matched nobody and sent nothing while still answering 204. Until
 * an address is set here, that flow cannot work for this account.
 *
 * Self-service by construction: `PUT /api/auth/profile/email` takes no employee id and
 * writes only the token holder's row, so nobody can point somebody else's reset link
 * at their own inbox.
 */
function ResetEmailCard({ email }: { email?: string | null }) {
  const toast = useToast();
  const qc = useQueryClient();
  const [value, setValue] = useState(email ?? "");

  const save = useMutation({
    mutationFn: async (address: string) =>
      (await api.put<Profile>("/api/auth/profile/email", { email: address })).data,
    onSuccess: (row) => {
      qc.invalidateQueries({ queryKey: ["auth", "profile"] });
      toast.success(`Reset links will go to ${row.email}`);
    },
  });

  const changed = value.trim().toLowerCase() !== (email ?? "").toLowerCase();

  return (
    <Card>
      <CardBody className="p-4 sm:p-5">
        <h2 className="mb-1 font-display text-base font-bold text-ink">Recovery email</h2>
        <p className="mb-3 text-sm text-muted">
          {email
            ? "Where a “forgot password” link is sent. Only you can change this."
            : "You have no recovery email. Until one is set, “forgot password” cannot "
              + "reach you — ask an administrator to reset it instead."}
        </p>

        <ErrorBanner error={save.error} />

        <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
          <div className="flex-1">
            <Field label="Email address">
              <Input
                type="email"
                value={value}
                placeholder="name@company.com"
                onChange={(e) => setValue(e.target.value)}
              />
            </Field>
          </div>
          <Button
            disabled={!changed || !value.trim() || save.isPending}
            onClick={() => save.mutate(value.trim())}
          >
            {save.isPending ? "Saving…" : "Save"}
          </Button>
        </div>
      </CardBody>
    </Card>
  );
}

const THEME_ICONS: Record<ThemeChoice, React.ReactNode> = {
  light: <Sun className="h-4 w-4" />,
  dark: <Moon className="h-4 w-4" />,
  system: <Monitor className="h-4 w-4" />,
};

/**
 * Appearance — MOVED HERE from Company Settings (2026-08-26).
 *
 * The choice is per-device: `shared/theme` keeps it in this browser's localStorage,
 * it is never sent to the server and never shared with anyone. On Company Settings it
 * sat behind `admin.settings.manage`, so every employee in the company was locked out
 * of their own display preference and an admin was editing a personal setting on a
 * company screen. Profile needs no permission, which is the right gate for it.
 *
 * Applies on press and is not part of any saved form.
 */
function AppearanceCard() {
  const [choice, setChoice] = useState<ThemeChoice>(() => getTheme());
  return (
    <Card>
      <CardBody className="p-4 sm:p-5">
        <h2 className="mb-1 text-sm font-semibold uppercase tracking-wider text-muted">
          Appearance
        </h2>
        <p className="mb-3 text-xs text-muted">
          Applies to this browser only. Everyone starts on Light.
        </p>
        <div className="flex flex-wrap gap-2">
          {THEME_OPTIONS.map((option) => {
            const active = choice === option.value;
            return (
              <button
                key={option.value}
                type="button"
                aria-pressed={active}
                onClick={() => {
                  setChoice(option.value);
                  setTheme(option.value);
                }}
                className={`flex min-h-11 items-center gap-2 rounded-xl border px-4 text-sm font-semibold transition ${
                  active
                    ? "border-brand/40 bg-brand-050 text-brand"
                    : "border-line bg-content1 text-body hover:bg-content2"
                }`}
              >
                {THEME_ICONS[option.value]}
                {option.label}
              </button>
            );
          })}
        </div>
      </CardBody>
    </Card>
  );
}

export function ProfilePage() {
  const { logout } = useAuth();
  const { data, isLoading, error } = useQuery({
    queryKey: ["auth", "profile"],
    queryFn: async () => (await api.get<Profile>("/api/auth/profile")).data,
  });

  if (isLoading) {
    return (
      <div className="grid place-items-center py-20">
        <Spinner label="Loading your profile…" />
      </div>
    );
  }
  if (error) return <ErrorBanner error={error} />;
  if (!data) return null;

  return (
    <>
      <PageHeader
        eyebrow="Account"
        title="My profile"
        actions={
          <Button variant="subtle" onClick={logout}>
            <LogOut className="h-4 w-4" /> Sign out
          </Button>
        }
      />

      <div className="flex flex-col gap-4">
        <Card>
          <CardBody className="flex flex-row items-center gap-4 p-4 sm:p-5">
            <Avatar size="lg" name={data.name} className="shrink-0 bg-brand-050 text-brand" />
            <div className="min-w-0">
              <div className="truncate font-display text-lg font-bold text-ink">{data.name}</div>
              <div className="truncate text-sm text-muted">
                {data.code ?? `Employee #${data.id}`}
                {data.department_name ? ` · ${data.department_name}` : ""}
              </div>
              <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                <StatusPill status={data.is_active ? "ACTIVE" : "INACTIVE"} />
                {data.roles.map((r) => (
                  <Chip key={r.code} size="sm" variant="flat">
                    {r.name ?? r.code}
                  </Chip>
                ))}
              </div>
            </div>
          </CardBody>
        </Card>

        <Section title="Identity">
          <Row label="Employee ID" value={data.id} />
          <Row label="Employee code" value={data.code} />
          <Row label="Full name" value={data.name} />
          <Row label="Email" value={data.email} />
          <Row label="Mobile" value={data.mobile} />
          <Row label="Status" value={data.is_active ? "Active" : "Inactive"} />
        </Section>

        <Section title="Organisation">
          <Row
            label="Department"
            value={data.department_name && `${data.department_name} (#${data.department_id})`}
          />
          <Row label="Section" value={data.section_name ?? (data.section_id || null)} />
          <Row label="Office" value={data.office?.name} />
          <Row label="Office code" value={data.office?.code} />
          <Row label="Office type" value={data.office?.office_type} />
          <Row
            label="Office address"
            value={[data.office?.address, data.office?.city, data.office?.state]
              .filter(Boolean)
              .join(", ")}
          />
          <Row
            label="Project"
            value={data.project_name && `${data.project_name} (#${data.project_id})`}
          />
          <Row label="Warehouse module is called" value={data.warehouse_label} />
        </Section>

        <Section title={`Positions (${data.positions.length})`}>
          {data.positions.length === 0 ? (
            <div className="py-2 text-sm text-muted">No position assigned in HCM.</div>
          ) : (
            <div className="flex flex-col gap-3">
              {data.positions.map((p) => (
                <div key={p.id} className="rounded-xl border border-line/70 p-3">
                  <div className="mb-1 flex flex-wrap items-center gap-2">
                    <span className="font-semibold text-ink">{p.name}</span>
                    {p.is_primary && (
                      <Chip size="sm" color="primary" variant="flat">Primary</Chip>
                    )}
                    {p.id === data.active_position_id && (
                      <Chip size="sm" color="success" variant="flat">Working as</Chip>
                    )}
                    {!p.is_active && <Chip size="sm" variant="flat">Inactive</Chip>}
                  </div>
                  <Row label="Position ID / code" value={`${p.id}${p.code ? ` · ${p.code}` : ""}`} />
                  {/* The rank the approval ladder climbs — HCM's org role, not an SCM
                      permission role. Worth naming here because it is what decides who
                      a request goes to. */}
                  <Row label="Rank (HCM role)" value={p.role_name} />
                  <Row label="Job" value={p.job_name} />
                  <Row label="Level" value={p.level_name} />
                  <Row label="Reports to" value={p.parent_position_name} />
                  <Row label="Department" value={p.department_name} />
                  <Row label="Office" value={p.office_name} />
                  <Row label="Project" value={p.project_name} />
                  <Row
                    label="Valid"
                    value={`${day(p.valid_from)} → ${p.valid_to ? day(p.valid_to) : "open"}`}
                  />
                </div>
              ))}
            </div>
          )}
        </Section>

        <Section title="Account">
          <Row label="Last sign-in" value={when(data.account?.last_login_at)} />
          <Row label="Account created" value={when(data.account?.created_at)} />
          <Row
            label="Password change required"
            value={data.account?.must_change_password ? "Yes" : "No"}
          />
          <Row label="Locked" value={data.account?.is_locked ? "Yes" : "No"} />
          <Row label="Last HCM sync" value={when(data.synced_at)} />
        </Section>

        <ResetEmailCard email={data.email} />

        <AppearanceCard />

        <ChangePassword mustChange={!!data.account?.must_change_password} />

      </div>
    </>
  );
}
