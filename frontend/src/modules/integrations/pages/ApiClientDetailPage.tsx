import { useState } from "react";
import { useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BookOpen, Activity, KeyRound, Link2, Pencil, Power } from "lucide-react";
import {
  Button, Card, ErrorBanner, PageHeader, SubNav, useToast, type SubNavItem,
} from "@/shared/components";
import { fmtDateTime } from "@/shared/datetime";
import { integrationsApi } from "../api";
import { ClientFormModal } from "../components/ClientFormModal";
import { ConnectionDocsPanel } from "../components/ConnectionDocsPanel";
import { EndpointsPanel } from "../components/EndpointsPanel";
import { HealthPill, healthOf } from "../components/Health";
import { KeysPanel } from "../components/KeysPanel";
import { Steps } from "../components/Explain";
import { UsagePanel } from "../components/UsagePanel";

const TABS: SubNavItem[] = [
  { key: "endpoints", label: "APIs", icon: Link2 },
  { key: "keys", label: "Keys", icon: KeyRound },
  { key: "usage", label: "Usage", icon: Activity },
  // What you send the partner — base address, auth header, the probe and directory
  // routes, and every endpoint with what it accepts and returns. The card above the
  // tabs prints the first four of those, but neither is a hand-kept copy: both read
  // the one document the server derives from the endpoints, through the one composer
  // in `snippets.ts`, so they cannot drift from each other or from what is served.
  { key: "docs", label: "Connection details", icon: BookOpen },
];

/** One application: the APIs built for it, its credentials, and what it has been
 *  doing — plus, at the top, whether the three things that make it work actually
 *  exist. The screen used to open on a builder with no statement of where in the
 *  setup this application had got to. */
export default function ApiClientDetailPage() {
  const { code = "" } = useParams();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [tab, setTab] = useState("endpoints");
  const [editing, setEditing] = useState(false);

  const client = useQuery({
    queryKey: ["apis", "client", code],
    queryFn: () => integrationsApi.getClient(code),
    enabled: Boolean(code),
  });

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ["apis", "client", code] });
    queryClient.invalidateQueries({ queryKey: ["apis", "clients"] });
  };

  /* Switching an application off refuses EVERY key it holds — the health pill has
   * always described that state ("Its keys are refused until it is switched back
   * on") and no press could reach it in either direction. It is its own button
   * rather than a field on the form: it is felt on somebody else's machine the
   * moment it is pressed, which is not something to do while editing a contact
   * email. The record, its keys and its endpoints are all kept. */
  const setActive = useMutation({
    mutationFn: (active: boolean) => integrationsApi.updateClient(code, {
      code: client.data!.code,
      name: client.data!.name,
      description: client.data!.description ?? "",
      contact_person: client.data!.contact_person ?? "",
      contact_email: client.data!.contact_email ?? "",
      is_active: active,
    }),
    onSuccess: (_saved, active) => {
      refresh();
      toast.success(active
        ? `${code} switched back on — its keys are accepted again`
        : `${code} switched off — every call using its keys is now refused`);
    },
    onError: () => toast.error("Could not turn this app on or off. Try again."),
  });

  if (client.error) return <ErrorBanner error="This application could not be loaded." />;

  const data = client.data;
  const health = data ? healthOf(data) : null;

  return (
    <div>
      <PageHeader
        // The name, not the code: the code is on the chip below and in every URL on
        // the screen already. A page titled "BILLING" makes the reader translate.
        title={data?.name ?? code}
        back={{ to: "/admin/integrations", label: "Back to Integrations" }}
      />

      <Card className="mb-5 p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <code className="rounded bg-content2 px-2 py-0.5 text-xs font-semibold text-ink">
                {data?.code ?? code}
              </code>
              {health && <HealthPill health={health} />}
            </div>
            <p className="mt-1.5 max-w-2xl text-sm text-body">
              {data?.description || "No description recorded for this application."}
            </p>
            <div className="mt-1 text-xs text-muted">
              Owner: {data?.contact_person ?? "—"}
              {data?.contact_email ? ` · ${data.contact_email}` : ""}
              {data?.last_called_at ? ` · last call seen ${fmtDateTime(data.last_called_at)}` : ""}
            </div>
          </div>
        </div>

        {/* The same three steps as the list screen, ticked off against this
            application's own counts. It answers "what is left to do here" without
            the reader having to open two tabs to work it out. */}
        {data && (
          <Steps
            className="mt-4"
            steps={[
              { title: "Registered", done: true,
                note: `Created ${data.created_at ? fmtDateTime(data.created_at) : "—"}${
                  data.created_by_name ? ` by ${data.created_by_name}` : ""}` },
              { title: data.endpoints ? `${data.endpoints} API${data.endpoints === 1 ? "" : "s"} built` : "No API built",
                done: data.endpoints > 0,
                note: data.endpoints
                  ? "The tables and columns this application may read."
                  : "Build one on the APIs tab — it is live the moment you save." },
              { title: data.active_keys ? `${data.active_keys} key${data.active_keys === 1 ? "" : "s"} active` : "No key issued",
                done: data.active_keys > 0,
                note: data.active_keys
                  ? "Sent to the owner. A key is shown once and never again."
                  : "Issue one on the Keys tab and hand it to the owner." },
            ]}
          />
        )}

        {/* Everything that CHANGES the application record itself, in one row — the
            same shape the webhook screen uses. The tabs below change what it may
            reach; these two change what it IS. */}
        {data && (
          <div className="mt-4 flex flex-wrap gap-2">
            <Button variant="subtle" onClick={() => setEditing(true)}>
              <Pencil className="h-4 w-4" /> Edit
            </Button>
            {data.is_active ? (
              <Button variant="dangerSoft" disabled={setActive.isPending}
                      onClick={() => setActive.mutate(false)}>
                <Power className="h-4 w-4" /> Switch off
              </Button>
            ) : (
              <Button variant="soft" disabled={setActive.isPending}
                      onClick={() => setActive.mutate(true)}>
                <Power className="h-4 w-4" /> Switch on
              </Button>
            )}
          </div>
        )}
      </Card>

      <SubNav label="Application" items={TABS} value={tab} onChange={setTab} />

      {tab === "endpoints" && <EndpointsPanel clientCode={code} />}
      {tab === "docs" && <ConnectionDocsPanel clientCode={code} />}
      {tab === "keys" && <KeysPanel clientCode={code} />}
      {tab === "usage" && <UsagePanel clientCode={code} />}

      <ClientFormModal
        open={editing}
        editing={data ?? null}
        onClose={() => setEditing(false)}
        onSaved={() => setEditing(false)}
      />
    </div>
  );
}
