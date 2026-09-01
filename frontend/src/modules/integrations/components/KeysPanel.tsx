import { useCallback, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Modal, ModalBody, ModalContent, ModalFooter, ModalHeader } from "@heroui/react";
import { KeyRound, ShieldAlert } from "lucide-react";
import {
  Button, Card, ConfirmModal, EmptyState, ErrorBanner, Field, Input, ResponsiveList,
  StatusPill, useToast, type Column,
} from "@/shared/components";
import { fmtDate, fmtDateTime, fmtRelative } from "@/shared/datetime";
import { integrationsApi } from "../api";
import { CopyButton, CopyChip, SecretField } from "./Copyable";
import type { ApiKey, IssuedKey, KeyWrite } from "../types";

const BLANK: KeyWrite = { label: "", scopes: [], rate_limit_per_min: 120, expires_at: null };

/**
 * Keys for one application. Issuing still shows the key in a dialog that has to be
 * dismissed deliberately, and the list can hand it out again afterwards: `POST
 * /keys/{prefix}/reveal` returns the whole value on `integration.keys.manage`, the
 * same permission that issued it. So copying a row copies the KEY, never the prefix —
 * a prefix pastes into nothing, and a press that said "Copied" while putting eight
 * characters on the clipboard is a call the partner cannot make. Keys issued before
 * the console kept a copyable value have only a hash behind them; the reveal says so
 * rather than quietly falling back to the prefix.
 *
 * Revoking asks first (2026-09-01). It is the one press on this console that breaks a
 * working integration on somebody else's machine, it took effect on a single click of
 * a button sitting in the row, and there is no undo — a replacement key is a new key,
 * which the partner has to be sent and has to deploy.
 */
export function KeysPanel({ clientCode }: { clientCode: string }) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<KeyWrite | null>(null);
  const [issued, setIssued] = useState<IssuedKey | null>(null);
  const [issuedKeys, setIssuedKeys] = useState<Record<string, string>>({});
  const [revoking, setRevoking] = useState<ApiKey | null>(null);
  // The key whose value is being pasted back in, and what has been typed so far.
  const [attaching, setAttaching] = useState<ApiKey | null>(null);
  const [pasted, setPasted] = useState("");
  // Keys already fetched, and the fetches in flight — a hover and the press that
  // follows it must not become two reveals of the same key.
  const cache = useRef<Record<string, string>>({});
  const inFlight = useRef<Record<string, Promise<string>>>({});

  const fullKey = useCallback(async (prefix: string): Promise<string> => {
    const held = issuedKeys[prefix] ?? cache.current[prefix];
    if (held) return held;
    if (!inFlight.current[prefix]) {
      inFlight.current[prefix] = integrationsApi
        .revealKey(prefix)
        .then((key) => {
          cache.current[prefix] = key.api_key;
          return key.api_key;
        })
        .finally(() => {
          delete inFlight.current[prefix];
        });
    }
    return inFlight.current[prefix];
  }, [issuedKeys]);

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
      setIssuedKeys((held) => ({ ...held, [key.key_prefix]: key.api_key }));
    },
  });

  const attach = useMutation({
    mutationFn: ({ prefix, key }: { prefix: string; key: string }) =>
      integrationsApi.attachKey(prefix, key),
    onSuccess: (row) => {
      queryClient.invalidateQueries({ queryKey: ["apis"] });
      // Copyable from this moment, without a round trip: the server kept exactly the
      // string that was pasted, because that is the only string that matched.
      cache.current[row.key_prefix] = pasted.trim();
      setAttaching(null);
      setPasted("");
      toast.success("Key attached. The row copies it in full now.");
    },
  });

  const revoke = useMutation({
    mutationFn: (prefix: string) => integrationsApi.revokeKey(prefix),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["apis"] });
      setRevoking(null);
      toast.success("Key revoked. Any call using it now fails.");
    },
  });

  const toggleScope = (slug: string) => {
    if (!draft) return;
    setDraft({
      ...draft,
      scopes: draft.scopes.includes(slug)
        ? draft.scopes.filter((s) => s !== slug)
        : [...draft.scopes, slug],
    });
  };

  /**
   * What the row offers where the key goes.
   *
   * A key issued from here is copyable from birth, and one issued before the console
   * kept a copyable value heals itself the first time its partner calls — the header
   * proves itself against the stored hash, so `security.require_api_key` can record
   * it. Until that call happens the server holds only a digest, which nobody can run
   * backwards, so the row asks for the value rather than offering a press that fails.
   *
   * Except on a revoked key: its value opens nothing, so there is nothing to recover
   * and the chip is inert — an affordance that leads somewhere pointless reads as one
   * more thing that is broken.
   */
  const keyChip = (row: ApiKey) =>
    row.can_copy || issuedKeys[row.key_prefix] ? (
      <CopyChip
        value={issuedKeys[row.key_prefix] ?? ""}
        resolve={() => fullKey(row.key_prefix)}
        display={row.masked_key}
        tag="key"
        copiedMessage="Full API key copied"
        title="Copies the full API key — everything behind the dots, ready to paste into X-API-Key."
      />
    ) : row.state === "REVOKED" ? (
      <span
        title="Revoked, and stored as a hash only. Its value opens nothing, so there is nothing to recover."
        className="mt-1 inline-flex max-w-full items-center gap-1.5 rounded-md border
                   border-line bg-content2 px-2 py-1 font-mono text-[11px] text-muted opacity-60"
      >
        <span className="truncate">{row.masked_key}</span>
      </span>
    ) : (
      <button
        type="button"
        onClick={() => { setPasted(""); setAttaching(row); }}
        title="Only this key's hash is stored, so it cannot be read back. Paste the key you were given and the row will copy it from then on."
        className="mt-1 inline-flex max-w-full items-center gap-1.5 rounded-md border
                   border-warn/40 bg-content2 px-2 py-1 font-mono text-[11px] text-muted
                   transition hover:border-warn hover:text-ink focus-visible:outline-none
                   focus-visible:ring-2 focus-visible:ring-warn/30"
      >
        <span className="truncate">{row.masked_key}</span>
        <span className="shrink-0 rounded border border-warn/40 bg-content1 px-1 text-[9px]
                         font-semibold uppercase tracking-wider text-warn">
          paste to copy
        </span>
      </button>
    );

  const columns: Column<ApiKey>[] = [
    {
      key: "label",
      header: "Key",
      // The row shows the key masked and copies it whole — the mask is so the screen
      // can be shared, not a limit on what the press hands over.
      render: (row) => (
        <div className="min-w-0">
          <div className="font-semibold text-ink">{row.label}</div>
          {keyChip(row)}
        </div>
      ),
    },
    {
      key: "scopes",
      header: "May call",
      render: (row) => (
        <span className="text-sm text-body">
          {row.scopes.length
            ? `${row.scopes.length} of this application's APIs`
            : "every API of this application"}
        </span>
      ),
    },
    {
      key: "limits",
      header: "Limits",
      hideOnNarrow: true,
      // Both numbers that decide whether a call is refused, together. The expiry was
      // recorded at issue time and then shown nowhere, so a key that stopped working
      // overnight looked like a server fault.
      render: (row) => (
        <div className="text-sm">
          <div className="text-ink">
            {row.rate_limit_per_min ? `${row.rate_limit_per_min}/min` : "no rate cap"}
          </div>
          <div className="text-xs text-muted">
            {row.expires_at ? `expires ${fmtDate(row.expires_at)}` : "no expiry"}
          </div>
        </div>
      ),
    },
    {
      key: "used",
      header: "Last used",
      render: (row) => (
        <div className="text-sm">
          <div className="text-ink">
            {row.last_used_at ? fmtRelative(row.last_used_at) : "Never"}
          </div>
          {row.last_used_at && (
            <div className="text-xs text-muted">{fmtDateTime(row.last_used_at)}</div>
          )}
        </div>
      ),
    },
    { key: "state", header: "State", render: (row) => <StatusPill status={row.state} /> },
    {
      key: "actions",
      header: "",
      render: (row) =>
        row.state === "ACTIVE" ? (
          <Button variant="dangerSoft" onClick={() => setRevoking(row)}>
            Revoke
          </Button>
        ) : null,
    },
  ];

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-start justify-between gap-2">
        <p className="max-w-2xl text-sm text-muted">
          A key is the password this application calls with — it goes in the{" "}
          <code className="text-ink">X-API-Key</code> header of every request. The row
          shows it masked so the screen can be shared; copying a row copies the whole
          key. A row marked <span className="text-warn">paste to copy</span> predates
          that and is stored as a hash only: it clears itself the next time that
          application calls in, or you can paste the value once and be done.
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
            hint="Until one exists nothing can call this application's APIs. Issue a key and hand it to the owner — it goes in the X-API-Key header."
            action={
              <Button onClick={() => setDraft({ ...BLANK })}>
                <KeyRound className="h-4 w-4" /> Issue key
              </Button>
            }
          />
        }
        renderCard={(row) => (
          <div>
            <div className="flex items-center justify-between gap-2">
              <span className="font-semibold text-ink">{row.label}</span>
              <StatusPill status={row.state} />
            </div>
            {keyChip(row)}
            <div className="mt-1 text-xs text-muted">
              {row.scopes.length ? `${row.scopes.length} APIs` : "every API"} ·{" "}
              {row.rate_limit_per_min ? `${row.rate_limit_per_min}/min` : "no rate cap"} ·
              {" "}last used {row.last_used_at ? fmtRelative(row.last_used_at) : "never"}
            </div>
            {row.state === "ACTIVE" && (
              <div className="mt-2">
                <Button variant="dangerSoft" onClick={() => setRevoking(row)}>
                  Revoke
                </Button>
              </div>
            )}
          </div>
        )}
      />

      {/* Paste the value back in. Only accepted if it hashes to what was issued, so a
          wrong paste is refused here rather than becoming a key that copies nonsense. */}
      <Modal isOpen={attaching !== null} onClose={() => setAttaching(null)} size="lg">
        <ModalContent>
          <ModalHeader className="font-display text-lg font-bold text-ink">
            Attach the value of {attaching?.label}
          </ModalHeader>
          <ModalBody className="gap-3">
            <p className="text-sm text-body">
              This key was issued before the console kept a copyable value, so only its
              hash is stored and nobody — including this screen — can read it back.
              Paste the key you were given and the row will copy it from then on. It is
              checked against the hash, so a mistyped key is refused, not saved.
            </p>
            <Field label="API key" required
                   hint={`Starts with ${attaching?.key_prefix ?? ""}. If you no longer have it, revoke this key and issue a new one instead.`}>
              <Input value={pasted} placeholder={attaching?.masked_key}
                     onChange={(e) => setPasted(e.target.value)} />
            </Field>
            {attach.error && <ErrorBanner error={attach.error} />}
          </ModalBody>
          <ModalFooter>
            <Button variant="subtle" onClick={() => setAttaching(null)}>Cancel</Button>
            <Button disabled={!pasted.trim() || attach.isPending}
                    onClick={() => attaching && attach.mutate({
                      prefix: attaching.key_prefix, key: pasted.trim(),
                    })}>
              Attach the key
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>

      {/* Revoking is instant, remote and permanent — so it is asked, and the question
          names the key and says what breaks. */}
      <ConfirmModal
        isOpen={revoking !== null}
        title={`Revoke ${revoking?.label ?? "this key"}?`}
        message={
          <>
            Every call using <code className="text-ink">{revoking?.masked_key}</code> is
            refused from the moment you confirm, including a job running right now.
            This cannot be undone — the application has to be sent a new key and
            redeployed with it.
          </>
        }
        confirmLabel="Revoke the key"
        danger
        busy={revoke.isPending}
        error={revoke.error}
        onConfirm={() => revoking && revoke.mutate(revoking.key_prefix)}
        onClose={() => setRevoking(null)}
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
                <p className="rounded-xl bg-content2 p-3 text-xs leading-relaxed text-muted">
                  The key is shown in full on the next screen, and the row on this list
                  can copy it again afterwards — anyone with permission to issue keys
                  can read it, so hand it out the way you would a password.
                </p>
                <Field label="Label" required
                       hint="What this key is for — 'nightly sync'. It is how you will know which one to revoke later.">
                  <Input value={draft.label} placeholder="Nightly sync"
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
                    Which APIs this key may call
                  </div>
                  <p className="mb-2 text-xs text-muted">
                    Tick none to allow every API of this application, including ones
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
                        No API built yet. Issue the key anyway — it will reach whatever
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
          <ModalBody className="gap-3">
            <p className="text-sm text-body">{issued?.warning}</p>
            {/* The one credential surface, shared with the webhook secret: click it
                and it is copied, and it stays a selectable field either way — on a
                plain-http host `navigator.clipboard` does not exist, and this value
                can never be shown again, so there is always a way to take it by
                hand. It opens revealed for that reason too. */}
            <SecretField
              label={`API key — ${issued?.label ?? ""}`}
              value={issued?.api_key ?? ""}
              revealed
              note="Hide blanks it out if you need to share this screen; it is still copied in full."
            />
            <Card className="mt-1 p-3">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="text-[11px] font-semibold uppercase tracking-wider text-muted">
                    How they use it
                  </div>
                  <code className="mt-1 block break-all text-xs text-ink">
                    curl -H &quot;X-API-Key: {issued?.api_key}&quot; &lt;api address&gt;
                  </code>
                </div>
                <CopyButton
                  value={`curl -H "X-API-Key: ${issued?.api_key ?? ""}" <api address>`}
                  label="Copy curl"
                />
              </div>
              <p className="mt-1 text-xs text-muted">
                Connection details, on the last tab, has the addresses and a worked
                example to send them.
              </p>
            </Card>
          </ModalBody>
          <ModalFooter>
            <Button onClick={() => setIssued(null)}>I have copied it</Button>
          </ModalFooter>
        </ModalContent>
      </Modal>
    </div>
  );
}
