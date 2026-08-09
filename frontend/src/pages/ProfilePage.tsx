import { useQuery } from "@tanstack/react-query";
import { Avatar, Chip, Spinner } from "@heroui/react";
import { LogOut } from "lucide-react";
import { CardBody } from "@heroui/react";
import { api } from "@/shared/api/client";
import { useAuth } from "@/shared/auth/AuthContext";
import { Button, Card, ErrorBanner, PageHeader, StatusPill } from "@/shared/components";
import { fmtDate, fmtDateTime } from "@/shared/datetime";

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

        <Section title={`Permissions (${data.permissions.length})`}>
          <div className="flex flex-wrap gap-1.5 pt-1">
            {data.permissions.length === 0 ? (
              <span className="text-sm text-muted">None granted.</span>
            ) : (
              data.permissions.map((code) => (
                <Chip key={code} size="sm" variant="flat" className="font-mono text-[11px]">
                  {code}
                </Chip>
              ))
            )}
          </div>
        </Section>
      </div>
    </>
  );
}
