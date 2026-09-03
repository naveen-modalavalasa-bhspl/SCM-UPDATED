import { useState } from "react";
import { useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BookOpen, Inbox, KeyRound, Pencil, Power, RotateCcw } from "lucide-react";
import {
  Button, Card, ErrorBanner, PageHeader, SubNav, useToast, type SubNavItem,
} from "@/shared/components";
import { fmtDateTime } from "@/shared/datetime";
import { webhooksApi } from "../api";
import { CopyChip } from "../components/Copyable";
import { Steps } from "../components/Explain";
import { HealthPill, healthOfWebhook } from "../components/Health";
import { WebhookDocsPanel } from "../components/WebhookDocsPanel";
import { WebhookFormModal } from "../components/WebhookFormModal";
import { WebhookReceivedPanel } from "../components/WebhookReceivedPanel";

const TABS: SubNavItem[] = [
  { key: "received", label: "Received", icon: Inbox },
  // What you send the partner. The mirror of the application page's last tab, in the
  // same place, because it is read once at the start of an integration and rarely
  // after.
  { key: "docs", label: "Connection details", icon: BookOpen },
];

/**
 * One webhook — the push side's `ApiClientDetailPage`, and its own address.
 *
 * It was a dialog for one afternoon (2026-09-01) and that was wrong for the same
 * reason the applications side never did it: a registration a person comes back to,
 * links somebody at, and works in for ten minutes is a PAGE. In a box over the list it
 * had no address to send anyone, nowhere to put what it has received without stacking
 * a second dialog on the first, and the connection document — the thing an admin
 * actually opens this screen to copy — had to be read through a scrolling window the
 * size of a postcard.
 *
 * So the shape is the application page's, rung for rung: the name in the header, the
 * chip and the health pill under it, the three steps ticked against this webhook's own
 * counts, the actions in one row, and what it does day to day on tabs below.
 */
export default function WebhookDetailPage() {
  const { source = "" } = useParams();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [tab, setTab] = useState("received");
  const [editing, setEditing] = useState(false);

  const hook = useQuery({
    queryKey: ["apis", "webhook", source],
    queryFn: () => webhooksApi.get(source),
    enabled: Boolean(source),
  });

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ["apis", "webhook", source] });
    queryClient.invalidateQueries({ queryKey: ["apis", "webhooks"] });
  };

  // Reopens a stream a refused push wedged. The sender may then send any number;
  // the one it sends becomes the new cursor.
  const resetSeq = useMutation({
    mutationFn: () => webhooksApi.resetSequence(source),
    onSuccess: () => {
      refresh();
      toast.success(`${source} will accept any sequence on the next push`);
    },
    onError: () => toast.error("That sequence could not be reset."),
  });

  const disable = useMutation({
    mutationFn: () => webhooksApi.disable(source),
    onSuccess: () => { refresh(); toast.success(`${source} switched off`); },
    onError: () => toast.error("That webhook could not be switched off."),
  });

  // The way back. Switching off is a soft delete — the registration and everything it
  // received are kept — but there was no press that undid it: the button simply
  // disappeared, and the edit form deliberately carries no on/off control, so a
  // webhook switched off by accident refused every push for good. Saves the whole
  // registration through the same PUT the edit form uses; nothing else changes.
  const enable = useMutation({
    mutationFn: () => webhooksApi.update(source, {
      source: hook.data!.source,
      name: hook.data!.name ?? "",
      description: hook.data!.description ?? "",
      events: hook.data!.events,
      handler: hook.data!.handler,
      client_code: hook.data!.client_code ?? "",
      require_signature: hook.data!.require_signature,
      is_active: true,
    }),
    onSuccess: () => { refresh(); toast.success(`${source} switched back on`); },
    onError: () => toast.error("That webhook could not be switched back on."),
  });

  if (hook.error) return <ErrorBanner error="This webhook could not be loaded." />;

  const data = hook.data;
  const health = data ? healthOfWebhook(data) : null;

  return (
    <div>
      <PageHeader
        // The name, not the URL name: the chip below carries that, and every address
        // on the screen already spells it out.
        title={data?.name || source}
        // Back to the tab it was opened from, not to the one the screen happens to
        // open on — landing on Applications after closing a webhook reads as the app
        // having lost your place.
        back={{ to: "/admin/integrations?tab=webhooks", label: "Back to Integrations" }}
      />

      <Card className="mb-5 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <code className="rounded bg-content2 px-2 py-0.5 text-xs font-semibold text-ink">
            {data?.source ?? source}
          </code>
          {health && <HealthPill health={health} />}
        </div>
        <p className="mt-1.5 max-w-2xl text-sm text-body">
          {data?.description || "No description recorded for this webhook."}
        </p>
        {/* The address, one press from being pasted into an email — it is the single
            thing the sending system cannot start without. */}
        {data && <CopyChip value={data.url} display={data.url}
                          title="Copy the address they post to" />}
        <div className="mt-1 text-xs text-muted">
          Who may push: {data?.client_code || "any registered key"}
          {data?.created_by_name ? ` · registered by ${data.created_by_name}` : ""}
          {data?.last_received_at ? ` · last push ${fmtDateTime(data.last_received_at)}` : ""}
        </div>

        {/* The same three steps the list screen states, ticked against this webhook's
            own counts: what is left to do, here. */}
        {data && (
          <Steps
            className="mt-4"
            steps={[
              {
                title: "Registered", done: true,
                note: `Created ${data.created_at ? fmtDateTime(data.created_at) : "—"}`
                      + ` · accepts ${data.events.length} event`
                      + `${data.events.length === 1 ? "" : "s"}`,
              },
              {
                title: data.has_secret ? "Secret issued" : "No secret issued",
                done: data.has_secret,
                note: data.has_secret
                  ? "They sign every body with it. Reveal it from Connection details when needed."
                  : data.require_signature
                    ? "Until one is created every push is refused. Reveal it from Connection details."
                    : "Signing is switched off for this webhook, so pushes are accepted unsigned.",
              },
              {
                title: data.received_count
                  ? `${data.received_count} received`
                  : "Nothing received yet",
                done: data.received_count > 0,
                note: data.received_count
                  ? "Every push and what it did is on the Received tab."
                  : "Send them the address, the secret and their API key — Connection details writes all three out.",
              },
            ]}
          />
        )}

        {/* Everything that CHANGES this webhook, in one row: the tabs below only
            read. */}
        {data && (
          <div className="mt-4 flex flex-wrap gap-2">
            <Button variant="subtle" onClick={() => setEditing(true)}>
              <Pencil className="h-4 w-4" /> Edit
            </Button>
            <Button variant="subtle" onClick={() => setTab("docs")}>
              <KeyRound className="h-4 w-4" />
              Secret key
            </Button>
            {/* Only where a cursor exists, because only an hcm_mirror webhook has one
                and it is meaningless before the first push. */}
            {data.last_sequence != null && (
              <Button variant="subtle" disabled={resetSeq.isPending}
                      onClick={() => resetSeq.mutate()}>
                <RotateCcw className="h-4 w-4" /> Reset sequence
              </Button>
            )}
            {data.is_active ? (
              <Button variant="dangerSoft" disabled={disable.isPending}
                      onClick={() => disable.mutate()}>
                <Power className="h-4 w-4" /> Switch off
              </Button>
            ) : (
              <Button variant="soft" disabled={enable.isPending}
                      onClick={() => enable.mutate()}>
                <Power className="h-4 w-4" /> Switch on
              </Button>
            )}
          </div>
        )}
      </Card>

      <SubNav label="Webhook" items={TABS} value={tab} onChange={setTab} />

      {tab === "received" && <WebhookReceivedPanel source={source} />}
      {tab === "docs" && <WebhookDocsPanel source={source} />}

      <WebhookFormModal
        open={editing}
        editing={data ?? null}
        onClose={() => setEditing(false)}
        onSaved={() => setEditing(false)}
      />
    </div>
  );
}
