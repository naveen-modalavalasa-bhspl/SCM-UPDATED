import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Modal, ModalBody, ModalContent, ModalFooter, ModalHeader } from "@heroui/react";
import { Copy, KeyRound, ShieldAlert } from "lucide-react";
import {
  Button, Card, EmptyState, ErrorBanner, Field, Input, ResponsiveList, StatusPill,
  useToast, type Column,
} from "@/shared/components";
import { integrationsApi } from "../api";
import type { ApiKey, IssuedKey, KeyWrite } from "../types";

const when = (v?: string | null) => (v ? new Date(v).toLocaleString() : "—");

const BLANK: KeyWrite = { label: "", scopes: [], rate_limit_per_min: 120, expires_at: null };

/**
 * Keys for one application. The raw key exists in exactly one place for exactly one
 * moment — the response to the issue call — so it is held in component state and shown
 * in a dialog that has to be dismissed deliberately. Nothing re-fetches it, because
 * nothing can: the server kept a hash.
 */
export function KeysPanel({ clientCode }: { clientCode: string }) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<KeyWrite | null>(null);
  const [issued, setIssued] = useState<IssuedKey | null>(null);

  const keys = useQuery({
    queryKey: ["apis", "keys", clientCode],
    queryFn: () => integrationsApi.keys(clientCode),
  });

  // A key is scoped to endpoints, so the picker is this client's endpoint list.
  const endpoints = useQuery({
    queryKey: ["apis", "endpoints", clientCode],
    queryFn: () => integrationsApi.endpoints(clientCode),
  });

  const issue = useMutation({
    mutationFn: (body: KeyWrite) => integrationsApi.issueKey(clientCode, body),
    onSuccess: (key) => {
      queryClient.invalidateQueries({ queryKey: ["apis"] });
      setDraft(null);
      setIssued(key);
    },
  });

  const revoke = useMutation({
    mutationFn: (prefix: string) => integrationsApi.revokeKey(prefix),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["apis"] });
      toast.success("Key revoked. Any call using it now fails.");
    },
  });

  const copy = async (text: string) => {
    await navigator.clipboard.writeText(text);
    toast.success("Copied to clipboard");
  };

  const toggleScope = (slug: string) => {
    if (!draft) return;
    setDraft({
      ...draft,
      scopes: draft.scopes.includes(slug)
        ? draft.scopes.filter((s) => s !== slug)
        : [...draft.scopes, slug],
    });
  };

  const columns: Column<ApiKey>[] = [
    {
      key: "label",
      header: "Key",
      render: (row) => (
        <div>
          <div className="font-semibold text-ink">{row.label}</div>
          <div className="font-mono text-xs text-muted">{row.masked_key}</div>
        </div>
      ),
    },
    {
      key: "scopes",
      header: "May call",
      render: (row) => (
        <span className="text-sm text-body">
          {row.scopes.length
            ? `${row.scopes.length} endpoint${row.scopes.length === 1 ? "" : "s"}`
            : "every endpoint"}
        </span>
      ),
    },
    {
      key: "used",
      header: "Last used",
      hideOnNarrow: true,
      render: (row) => (
        <div className="text-sm">
          <div className="text-ink">{when(row.last_used_at)}</div>
          <div className="text-xs text-muted">{row.rate_limit_per_min}/min cap</div>
        </div>
      ),
    },
    { key: "state", header: "State", render: (row) => <StatusPill status={row.state} /> },
    {
      key: "actions",
      header: "",
      render: (row) =>
        row.state === "ACTIVE" ? (
          <Button variant="dangerSoft" onClick={() => revoke.mutate(row.key_prefix)}>
            Revoke
          </Button>
        ) : null,
    },
  ];

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted">
          A key is shown once, at the moment it is issued. Lost keys are replaced, never
          recovered.
        </p>
        <Button onClick={() => setDraft({ ...BLANK })}>
          <KeyRound className="h-4 w-4" /> Issue key
        </Button>
      </div>

      {keys.error && <ErrorBanner error="Keys could not be loaded." />}
      {issue.error && <ErrorBanner error={issue.error} />}
      {revoke.error && <ErrorBanner error={revoke.error} />}

      <ResponsiveList
        data={keys.data ?? []}
        columns={columns}
        keyOf={(row) => row.key_prefix}
        loading={keys.isLoading}
        empty={
          <EmptyState
            title="No key issued yet"
            hint="Issue one and hand it to the application's owner. It goes in the X-API-Key header."
          />
        }
        renderCard={(row) => (
          <div>
            <div className="flex items-center justify-between gap-2">
              <span className="font-semibold text-ink">{row.label}</span>
              <StatusPill status={row.state} />
            </div>
            <div className="mt-1 font-mono text-xs text-muted">{row.masked_key}</div>
            <div className="mt-1 text-xs text-muted">
              {row.scopes.length ? `${row.scopes.length} endpoints` : "every endpoint"} ·
              last used {when(row.last_used_at)}
            </div>
            {row.state === "ACTIVE" && (
              <div className="mt-2">
                <Button variant="dangerSoft" onClick={() => revoke.mutate(row.key_prefix)}>
                  Revoke
                </Button>
              </div>
            )}
          </div>
        )}
      />

      {/* Issue */}
      <Modal isOpen={draft !== null} onClose={() => setDraft(null)} size="2xl"
             scrollBehavior="inside">
        <ModalContent>
          <ModalHeader className="font-display text-lg font-bold text-ink">
            Issue an API key
          </ModalHeader>
          <ModalBody>
            {draft && (
              <div className="space-y-4">
                <Field label="Label" hint="What this key is for — 'nightly sync'.">
                  <Input value={draft.label}
                         onChange={(e) => setDraft({ ...draft, label: e.target.value })} />
                </Field>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <Field label="Rate limit (calls/minute)" hint="0 turns the cap off.">
                    <Input type="number" value={String(draft.rate_limit_per_min)}
                           onChange={(e) => setDraft({
                             ...draft, rate_limit_per_min: Number(e.target.value || 0),
                           })} />
                  </Field>
                  <Field label="Expires" hint="Blank for a key that does not expire.">
                    <Input type="date" value={(draft.expires_at ?? "").slice(0, 10)}
                           onChange={(e) => setDraft({
                             ...draft,
                             expires_at: e.target.value ? `${e.target.value}T23:59:59` : null,
                           })} />
                  </Field>
                </div>
                <div>
                  <div className="mb-1 text-sm font-medium text-body">
                    Which endpoints this key may call
                  </div>
                  <p className="mb-2 text-xs text-muted">
                    Tick none to allow every endpoint of this application, including ones
                    built later — the usual choice. Tick some to pin it down.
                  </p>
                  <div className="max-h-56 space-y-1 overflow-y-auto rounded-xl border border-line p-3">
                    {(endpoints.data ?? []).map((endpoint) => (
                      <label key={endpoint.slug}
                             className="flex min-h-11 cursor-pointer items-start gap-2">
                        <input type="checkbox" className="mt-1 h-4 w-4"
                               checked={draft.scopes.includes(endpoint.slug)}
                               onChange={() => toggleScope(endpoint.slug)} />
                        <span>
                          <span className="text-sm text-ink">{endpoint.name}</span>
                          <span className="block font-mono text-xs text-muted">
                            {endpoint.url}
                          </span>
                        </span>
                      </label>
                    ))}
                    {!(endpoints.data ?? []).length && (
                      <p className="text-xs text-muted">
                        No endpoint built yet. Issue the key anyway — it will reach whatever
                        you build next.
                      </p>
                    )}
                  </div>
                </div>
              </div>
            )}
          </ModalBody>
          <ModalFooter>
            <Button variant="subtle" onClick={() => setDraft(null)}>Cancel</Button>
            <Button disabled={!draft?.label || issue.isPending}
                    onClick={() => draft && issue.mutate(draft)}>
              Issue key
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>

      {/* Shown once */}
      <Modal isOpen={issued !== null} onClose={() => setIssued(null)} size="2xl">
        <ModalContent>
          <ModalHeader className="font-display text-lg font-bold text-ink">
            <span className="flex items-center gap-2">
              <ShieldAlert className="h-5 w-5 text-warn" /> Copy this key now
            </span>
          </ModalHeader>
          <ModalBody>
            <p className="text-sm text-body">{issued?.warning}</p>
            <Card className="mt-3 p-3">
              <div className="break-all font-mono text-sm text-ink">{issued?.api_key}</div>
            </Card>
            <Button className="mt-3" variant="soft"
                    onClick={() => issued && copy(issued.api_key)}>
              <Copy className="h-4 w-4" /> Copy key
            </Button>
          </ModalBody>
          <ModalFooter>
            <Button onClick={() => setIssued(null)}>I have copied it</Button>
          </ModalFooter>
        </ModalContent>
      </Modal>
    </div>
  );
}
