import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { BookOpen, Inbox, KeyRound } from "lucide-react";
import {
  Button, Card, ErrorBanner, SubNav, type SubNavItem,
} from "@/shared/components";
import { fmtDateTime } from "@/shared/datetime";
import { camsApi, integrationsApi } from "../api";
import { useCamsWrites } from "../camsEvents";
import { CamsDocsPanel } from "./CamsDocsPanel";
import { CamsReceivedPanel } from "./CamsReceivedPanel";
import { CopyChip } from "./Copyable";
import { Steps } from "./Explain";
import { HealthPill, healthOfAdapter } from "./Health";

/**
 * B-CAMS — the clinic app, and the only integration that MOVES STOCK from outside.
 *
 * It is not on the Webhooks tab and never will be. A webhook only records what
 * arrives; `facility.consumption` and `facility.wastage` deduct what the field used,
 * through `inventory.move_stock_out()` like every other movement, and B-CAMS also
 * reads fourteen feeds back. That needs a hand-written adapter (`adapters/cams/`), so
 * none of the webhook rows describe it and none of the webhook screens can operate it.
 *
 * Which left it with no screen at all between 2026-09-01 and 2026-09-06: the tab was
 * dropped in a refactor of the other two, the panel stayed on disk imported by nothing,
 * and the shared secret could only be minted by an API call while "did last night's
 * push land, and what did it do to our stock" was answerable only from the database. A
 * partner integration nobody can watch is one nobody notices has stopped.
 *
 * IT IS READ AND WORKED THE SAME WAY AS THE OTHER TWO TABS, which is what this shape is
 * for. The same header card an application and a webhook get — the code chip, the
 * health pill, the address one press from the clipboard, the three moves ticked against
 * this adapter's own counts — then the same two tabs under it, Received and Connection
 * details, carrying the same furniture in the same order. The only things that differ
 * are the ones that genuinely differ: there is nothing to register (it is code, not a
 * row), so there is no Edit and no switch, and the Result column counts LINES OF STOCK
 * rather than naming a handler.
 *
 * Nothing on this screen is written here. The name and the description come from
 * `/api/apis/adapters`, the address and the five endpoints from the connection
 * document, and both are built from the code that serves the traffic — so a screen that
 * disagrees with the integration is not reachable from this file.
 */
const TABS: SubNavItem[] = [
  { key: "received", label: "Received", icon: Inbox },
  { key: "docs", label: "Connection details", icon: BookOpen },
];

/** The adapter this panel operates. One constant, because the panel is B-CAMS-specific
 *  by construction — its status, its receipts and its document are three routes under
 *  `/api/apis/cams`. A second adapter gets its own panel beside this one, not a
 *  parameter on this one. */
const KEY = "cams";

export function CamsPanel() {
  const [tab, setTab] = useState("received");
  const { docs } = useCamsWrites();

  const status = useQuery({ queryKey: ["cams", "status"], queryFn: camsApi.status });
  const adapters = useQuery({
    queryKey: ["apis", "adapters"],
    queryFn: integrationsApi.adapters,
  });

  const adapter = (adapters.data ?? []).find((row) => row.key === KEY);
  const s = status.data;
  const health = s ? healthOfAdapter(s) : null;

  return (
    <div>
      <ErrorBanner error={status.error} />

      <Card className="mb-5 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <code className="rounded bg-content2 px-2 py-0.5 text-xs font-semibold text-ink">
            {adapter?.key ?? KEY}
          </code>
          {health && <HealthPill health={health} />}
        </div>
        <p className="mt-1.5 max-w-2xl text-sm text-body">
          {adapter?.description
            ?? "A hand-written adapter serving shapes the endpoint builder cannot compose."}
        </p>
        {/* The address, one press from being pasted into an email — it is the single
            thing the sending system cannot start without. */}
        {docs && <CopyChip value={docs.base_url} display={docs.base_url}
                           title="Copy the address they post to" />}
        <div className="mt-1 text-xs text-muted">
          Who may push: an API key scoped{" "}
          <code className="text-body">{adapter?.scope ?? KEY}</code>, signing every body
          {s?.last_received_at ? ` · last push ${fmtDateTime(s.last_received_at)}` : ""}
        </div>

        {/* The same three moves the tab above states, ticked against this adapter's own
            counts: what is left to do, here. */}
        {s && (
          <Steps
            className="mt-4"
            steps={[
              {
                title: "Installed", done: true,
                note: docs
                  ? `${docs.writes.length} write endpoint`
                    + `${docs.writes.length === 1 ? "" : "s"}, `
                    + `${docs.writes.filter((write) => write.deducts_stock).length} of `
                    + `which move stock · ${docs.feeds.length} read feeds`
                  : "Served from the adapter package — there is nothing to register.",
              },
              {
                title: s.configured ? "Secret issued" : "No secret issued",
                done: s.configured,
                note: s.configured
                  ? "They sign every body with it. Replace it from Connection details."
                  : "Until one is issued every write is refused. Issue it from Connection details.",
              },
              {
                title: s.events
                  ? `${s.events} push${s.events === 1 ? "" : "es"} received`
                  : "Nothing received yet",
                done: s.events > 0,
                // The counts that used to sit in a strip of their own. They belong on
                // this rung: "it arrived" and "here is what it did to the shelf" are
                // one fact, and separating them was how a push full of refused lines
                // read as a success.
                note: s.events
                  ? `${s.lines_posted} line${s.lines_posted === 1 ? "" : "s"} moved stock`
                    + (s.lines_skipped
                      ? ` · ${s.lines_skipped} refused — open them on Received`
                      : "")
                  : "Send them the address, the secret and their API key — Connection details writes all three out.",
              },
            ]}
          />
        )}

        {/* The one press that CHANGES anything here. The tabs below only read, and
            unlike a webhook there is no registration to edit and nothing to switch
            off. */}
        <div className="mt-4 flex flex-wrap gap-2">
          <Button variant="subtle" onClick={() => setTab("docs")}>
            <KeyRound className="h-4 w-4" /> Secret key
          </Button>
        </div>
      </Card>

      <SubNav label="B-CAMS" items={TABS} value={tab} onChange={setTab} />

      {tab === "received" ? <CamsReceivedPanel /> : <CamsDocsPanel />}
    </div>
  );
}
