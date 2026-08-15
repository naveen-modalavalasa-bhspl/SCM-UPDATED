import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Activity, ArrowLeft, KeyRound, Link2 } from "lucide-react";
import {
  Button, Card, ErrorBanner, PageHeader, StatusPill, SubNav, type SubNavItem,
} from "@/shared/components";
import { integrationsApi } from "../api";
import { EndpointsPanel } from "../components/EndpointsPanel";
import { KeysPanel } from "../components/KeysPanel";
import { UsagePanel } from "../components/UsagePanel";
import { absoluteUrl } from "../snippets";

const TABS: SubNavItem[] = [
  { key: "endpoints", label: "APIs", icon: Link2 },
  { key: "keys", label: "Keys", icon: KeyRound },
  { key: "usage", label: "Usage", icon: Activity },
];

/** One application: the APIs built for it, its credentials, and what it has been doing. */
export default function ApiClientDetailPage() {
  const { code = "" } = useParams();
  const navigate = useNavigate();
  const [tab, setTab] = useState("endpoints");

  const client = useQuery({
    queryKey: ["apis", "client", code],
    queryFn: () => integrationsApi.getClient(code),
    enabled: Boolean(code),
  });

  if (client.error) return <ErrorBanner error="This application could not be loaded." />;

  return (
    <div>
      <PageHeader
        eyebrow="APIS"
        title={client.data?.code ?? "Application"}
        actions={
          <Button variant="subtle" onClick={() => navigate("/admin/integrations")}>
            <ArrowLeft className="h-4 w-4" /> All applications
          </Button>
        }
      />

      <Card className="mb-5 p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="font-semibold text-ink">{client.data?.name}</div>
            <div className="text-sm text-muted">{client.data?.description ?? "—"}</div>
            <div className="mt-1 text-xs text-muted">
              Owner: {client.data?.contact_person ?? "—"}
              {client.data?.contact_email ? ` · ${client.data.contact_email}` : ""}
            </div>
          </div>
          <StatusPill status={client.data?.is_active ? "ACTIVE" : "INACTIVE"} />
        </div>
        <div className="mt-3 rounded-xl bg-content2 p-3 text-xs text-muted">
          Base address <span className="font-mono text-ink">{absoluteUrl("/api/ext/v1")}</span>{" "}
          · authenticate with the header{" "}
          <span className="font-mono text-ink">X-API-Key</span> · discovery route{" "}
          <span className="font-mono text-ink">/_endpoints</span>, health check{" "}
          <span className="font-mono text-ink">/_ping</span>.
        </div>
      </Card>

      <SubNav label="Application" items={TABS} value={tab} onChange={setTab} />

      {tab === "endpoints" && <EndpointsPanel clientCode={code} />}
      {tab === "keys" && <KeysPanel clientCode={code} />}
      {tab === "usage" && <UsagePanel clientCode={code} />}
    </div>
  );
}
