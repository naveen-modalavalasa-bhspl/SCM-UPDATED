import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Modal, ModalBody, ModalContent, ModalFooter, ModalHeader } from "@heroui/react";
import {
  AlertTriangle, BookOpen, Copy, KeyRound, PackageCheck, ShieldCheck,
} from "lucide-react";
import {
  Button, Card, EmptyState, ErrorBanner, ResponsiveList, Select, StatusPill,
  useToast, type Column,
} from "@/shared/components";
import { camsApi } from "../api";
import { CamsDocsModal } from "./CamsDocsModal";
import { fmtDateTime } from "@/shared/datetime";
import type { CamsEvent, CamsSecret } from "../types";

/**
 * B-CAMS — the clinic app, and the only integration that MOVES STOCK from outside.
 *
 * It is not on the Webhooks tab and never will be. A webhook only records what
 * arrives; `facility.consumption` and `facility.wastage` deduct what the field used,
 * through `inventory.move_stock_out()` like every other movement, and B-CAMS also
 * reads fourteen feeds back. That needs a hand-written adapter (`adapters/cams/`), so
 * none of the webhook rows describe it and none of the webhook screens can operate it.
 *
 * Which left it with no screen at all: the shared secret could only be minted by an
 * API call, and "did last night's push land, and what did it do to our stock" was
 * answerable only from the database. A partner integration nobody can watch is one
 * nobody notices has stopped.
 *
 * WHAT ARRIVED is therefore the point of this panel, not the secret. Every push
 * carries what it did — how many lines moved stock, how many could not, and the reason
 * for each — served from the receipt the adapter already stores, so this screen cannot
 * show an outcome the integration did not actually have.
 */

/** The five events B-CAMS may send, and whether each one moves stock. Two do. Saying
 *  so on the row is the difference between "a report arrived" and "our stock changed",
 *  which is the only thing a storekeeper reading this actually wants to know. */
const EVENT_LABEL: Record<string, { name: string; deducts: boolean }> = {
  "facility.consumption": { name: "Consumption", deducts: true },
  "facility.wastage": { name: "Wastage", deducts: true },
  "material_issue.acknowledged": { name: "Issue acknowledged", deducts: false },
  "facility.stock_balance": { name: "Field stock balance", deducts: false },
  "facility.stock_transfer": { name: "Stock transfer", deducts: false },
};

const eventName = (code: string) => EVENT_LABEL[code]?.name ?? code;

export function CamsPanel() {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [event, setEvent] = useState("");
  const [minted, setMinted] = useState<CamsSecret | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [open, setOpen] = useState<CamsEvent | null>(null);
  const [showDocs, setShowDocs] = useState(false);

  const status = useQuery({
    queryKey: ["cams", "status"],
    queryFn: camsApi.status,
  });

  // Loaded with the panel rather than with the modal: the base URL is shown on the
  // card itself, so waiting for a click to fetch it would leave the one thing
  // somebody opened this screen for blank until they opened something else.
  const docs = useQuery({
    queryKey: ["cams", "docs"],
    queryFn: camsApi.docs,
  });

  const events = useQuery({
    queryKey: ["cams", "events", event],
    queryFn: () => camsApi.events(event || undefined),
  });

  const rotate = useMutation({
    mutationFn: camsApi.rotateSecret,
    onSuccess: (result) => {
      setMinted(result);
      setConfirming(false);
      queryClient.invalidateQueries({ queryKey: ["cams", "status"] });
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const detail = useMutation({
    mutationFn: camsApi.event,
    onSuccess: (row) => setOpen(row),
    onError: (error: Error) => toast.error(error.message),
  });

  const columns: Column<CamsEvent>[] = [
    {
      key: "event",
      header: "Event",
      render: (row) => (
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold text-ink">
            {eventName(row.event)}
          </div>
          <div className="truncate font-mono text-xs text-muted">{row.event_id}</div>
        </div>
      ),
    },
    {
      key: "received",
      header: "Received",
      hideOnNarrow: true,
      render: (row) => (
        <span className="text-sm text-body">{fmtDateTime(row.received_at)}</span>
      ),
    },
    {
      key: "rows",
      header: "Lines",
      className: "text-right",
      render: (row) => <span className="tabular-nums text-sm">{row.rows ?? "—"}</span>,
    },
    {
      key: "effect",
      header: "Effect on stock",
      render: (row) => {
        // Absent, not zero: the three events that only record have no posting block at
        // all, and showing them as "0 posted" would read as a failure rather than as
        // "this one was never meant to move anything".
        if (!row.posting) {
          return <span className="text-sm text-muted">Recorded only</span>;
        }
        const { posted, skipped } = row.posting;
        return (
          <div className="text-sm">
            <span className={posted > 0 ? "font-semibold text-ok" : "text-muted"}>
              {posted} posted
            </span>
            {skipped > 0 && (
              <span className="ml-2 font-semibold text-bad">{skipped} refused</span>
            )}
          </div>
        );
      },
    },
    {
      key: "status",
      header: "Status",
      render: (row) => (
        <StatusPill
          status={row.posting && row.posting.skipped > 0 ? "PARTIAL" : "ACCEPTED"}
        />
      ),
    },
    {
      key: "open",
      header: "",
      render: (row) => (
        <Button variant="ghost" onClick={() => detail.mutate(row.event_id)}>
          Details
        </Button>
      ),
    },
  ];

  const s = status.data;

  return (
    <div className="space-y-5">
      <ErrorBanner error={status.error ?? events.error} />

      {/* WHERE they post. The first question a partner asks and, until now, the one
       *  thing this screen could not answer — the address lived in a spec document
       *  and in somebody's memory. Served, not written here: `docs.base_url` is built
       *  from the request, so what is shown is the host this browser actually reached
       *  SCM on, which is the host that will work for them (rule 13 — never a
       *  literal). */}
      <Card className="p-4">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <h3 className="font-display text-base font-bold text-ink">
              Where B-CAMS posts
            </h3>
            <code className="mt-1 block break-all text-sm text-body">
              {docs.data?.base_url ?? "…"}
            </code>
            <p className="mt-1 text-xs text-muted">
              Five endpoints under it, one per event. Full details and an example body
              for each are in the connection document.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="ghost"
              onClick={() => {
                void navigator.clipboard?.writeText(docs.data?.base_url ?? "");
                toast.success("Base URL copied");
              }}
              disabled={!docs.data}
            >
              <Copy className="h-4 w-4" /> Copy URL
            </Button>
            <Button variant="ghost" onClick={() => setShowDocs(true)}>
              <BookOpen className="h-4 w-4" /> Connection details
            </Button>
          </div>
        </div>
      </Card>

      {/* The secret, and what it costs to replace it. */}
      <Card className="p-4">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              {s?.configured ? (
                <ShieldCheck className="h-4 w-4 text-ok" />
              ) : (
                <AlertTriangle className="h-4 w-4 text-bad" />
              )}
              <h3 className="font-display text-base font-bold text-ink">
                Shared secret
              </h3>
            </div>
            <p className="mt-1 text-sm text-muted">
              {s?.configured
                ? `Issued ${fmtDateTime(s.rotated_at ?? "")}${
                    s.rotated_by_name ? ` by ${s.rotated_by_name}` : ""
                  }. B-CAMS signs every write with it.`
                : "Not issued yet — until it is, every write from B-CAMS is refused."}
            </p>
            <p className="mt-1 text-xs text-muted">
              They also need an API key, issued against their application on the
              Applications tab.
            </p>
          </div>
          <Button
            variant={s?.configured ? "ghost" : "primary"}
            onClick={() => (s?.configured ? setConfirming(true) : rotate.mutate())}
            disabled={rotate.isPending}
          >
            <KeyRound className="h-4 w-4" />
            {s?.configured ? "Replace secret" : "Generate secret"}
          </Button>
        </div>
      </Card>

      {/* The running total, so "is it live" is answerable without reading rows. */}
      {s && s.events > 0 && (
        <Card className="p-4">
          <div className="flex flex-wrap items-center gap-x-8 gap-y-2 text-sm">
            <span className="flex items-center gap-2 text-body">
              <PackageCheck className="h-4 w-4 text-muted" />
              {s.events} push{s.events === 1 ? "" : "es"} received
            </span>
            <span className="text-body">
              <span className="font-semibold text-ok">{s.lines_posted}</span> lines
              moved stock
            </span>
            {s.lines_skipped > 0 && (
              <span className="text-body">
                <span className="font-semibold text-bad">{s.lines_skipped}</span> lines
                refused
              </span>
            )}
            <span className="text-muted">
              Last: {fmtDateTime(s.last_received_at ?? "") || "—"}
            </span>
          </div>
        </Card>
      )}

      <div className="flex flex-wrap items-end justify-between gap-3">
        <h3 className="font-display text-base font-bold text-ink">What arrived</h3>
        <div className="w-full sm:w-64">
          <Select
            ariaLabel="Filter by event"
            value={event}
            onChange={setEvent}
            options={[
              { value: "", label: "All events" },
              ...Object.entries(EVENT_LABEL).map(([value, meta]) => ({
                value,
                label: meta.name,
              })),
            ]}
          />
        </div>
      </div>

      <ResponsiveList
        data={events.data?.items ?? []}
        columns={columns}
        keyOf={(row) => row.event_id}
        loading={events.isLoading}
        onRowClick={(row) => detail.mutate(row.event_id)}
        empty={
          <EmptyState
            title="Nothing from B-CAMS yet"
            hint={
              s?.configured
                ? "Their pushes will appear here the moment they arrive, with what each one did to stock."
                : "Issue the shared secret above, and an API key on the Applications tab, then send both to the B-CAMS team."
            }
          />
        }
        renderCard={(row) => (
          <div className="space-y-1">
            <div className="flex items-start justify-between gap-3">
              <span className="text-sm font-semibold text-ink">{eventName(row.event)}</span>
              <StatusPill
                status={row.posting && row.posting.skipped > 0 ? "PARTIAL" : "ACCEPTED"}
              />
            </div>
            <div className="font-mono text-xs text-muted">{row.event_id}</div>
            <div className="text-xs text-muted">
              {fmtDateTime(row.received_at)} · {row.rows ?? 0} lines
            </div>
            <div className="text-sm">
              {row.posting
                ? `${row.posting.posted} posted${
                    row.posting.skipped > 0 ? `, ${row.posting.skipped} refused` : ""
                  }`
                : "Recorded only"}
            </div>
          </div>
        )}
      />

      {/* Replacing a live secret breaks the partner until they update it. Said plainly
       *  rather than guarded by a disabled button — an admin may genuinely need to
       *  rotate one, they just must not do it without knowing. */}
      <Modal isOpen={confirming} onClose={() => setConfirming(false)} size="lg">
        <ModalContent>
          <ModalHeader className="font-display text-lg font-bold text-ink">
            Replace the B-CAMS shared secret?
          </ModalHeader>
          <ModalBody>
            <p className="text-sm text-body">
              A secret is already in use. Generating a new one takes effect
              immediately, and every write B-CAMS sends will be refused until they are
              given the replacement.
            </p>
            <p className="text-sm text-muted">
              The new secret is shown once and cannot be retrieved afterwards.
            </p>
          </ModalBody>
          <ModalFooter>
            <Button variant="ghost" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
            <Button onClick={() => rotate.mutate()} disabled={rotate.isPending}>
              {rotate.isPending ? "Generating…" : "Generate a new secret"}
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>

      {/* Shown once. Deliberately not dismissible by clicking away. */}
      <Modal isOpen={minted !== null} onClose={() => setMinted(null)} size="2xl">
        <ModalContent>
          <ModalHeader className="font-display text-lg font-bold text-ink">
            Shared secret — copy it now
          </ModalHeader>
          <ModalBody className="gap-3">
            <p className="text-sm text-body">{minted?.note}</p>
            <code className="block break-all rounded-lg bg-content1 p-3 font-mono text-sm text-ink">
              {minted?.shared_secret}
            </code>
            <p className="text-xs text-muted">
              Send it to the B-CAMS team over a private channel, never in a ticket.
              They sign the raw request body with it and send the result as the
              <span className="font-mono"> X-CAMS-Signature </span>
              header.
            </p>
          </ModalBody>
          <ModalFooter>
            <Button
              variant="ghost"
              onClick={() => {
                void navigator.clipboard?.writeText(minted?.shared_secret ?? "");
                toast.success("Copied");
              }}
            >
              Copy
            </Button>
            <Button onClick={() => setMinted(null)}>Done</Button>
          </ModalFooter>
        </ModalContent>
      </Modal>

      <CamsDocsModal open={showDocs} onClose={() => setShowDocs(false)} />

      {/* One push in full: the body they sent and, where it moved stock, every line
       *  that could not be posted and why. That list is the whole reason this screen
       *  exists — a refused line almost always means a receipt was never posted in
       *  SCM, not that the field is wrong. */}
      <Modal isOpen={open !== null} onClose={() => setOpen(null)} size="3xl">
        <ModalContent>
          <ModalHeader className="font-display text-lg font-bold text-ink">
            {open ? eventName(open.event) : ""} · {open?.event_id}
          </ModalHeader>
          <ModalBody className="gap-3">
            <div className="max-h-[60vh] overflow-y-auto overscroll-y-contain pr-1">
              <div className="space-y-4">
                <div className="grid grid-cols-1 gap-2 text-sm sm:grid-cols-2">
                  <div>
                    <span className="text-muted">Received: </span>
                    <span className="text-ink">
                      {fmtDateTime(open?.received_at ?? "")}
                    </span>
                  </div>
                  <div>
                    <span className="text-muted">Sent by: </span>
                    <span className="text-ink">{open?.client_code ?? "—"}</span>
                  </div>
                </div>

                {open?.posting && open.posting.problems.length > 0 && (
                  <div className="rounded-lg border border-bad/30 bg-bad-bg/40 p-3">
                    <p className="mb-1 text-sm font-semibold text-bad">
                      {open.posting.skipped} line
                      {open.posting.skipped === 1 ? "" : "s"} could not be posted
                    </p>
                    <ul className="space-y-1 text-xs text-body">
                      {open.posting.problems.map((problem) => (
                        <li key={problem}>{problem}</li>
                      ))}
                    </ul>
                  </div>
                )}

                {open?.payload_truncated && (
                  <p className="text-xs text-muted">
                    The body was too large to store and was logged instead; only its
                    digest and header fields are kept.
                  </p>
                )}

                <div>
                  <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted">
                    What they sent
                  </p>
                  <pre className="whitespace-pre-wrap break-all rounded-lg bg-content1 p-3 font-mono text-xs text-body">
                    {JSON.stringify(open?.payload ?? {}, null, 2)}
                  </pre>
                </div>
              </div>
            </div>
          </ModalBody>
          <ModalFooter>
            <Button onClick={() => setOpen(null)}>Close</Button>
          </ModalFooter>
        </ModalContent>
      </Modal>
    </div>
  );
}
