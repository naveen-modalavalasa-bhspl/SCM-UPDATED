import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Modal, ModalBody, ModalContent, ModalFooter, ModalHeader } from "@heroui/react";
import { Radio } from "lucide-react";
import {
  Button, ErrorBanner, Field, Input, Select, useToast,
} from "@/shared/components";
import { integrationsApi, webhooksApi } from "../api";
import { EventPicker } from "./EventPicker";
import type { Webhook, WebhookWrite } from "../types";

const BLANK: WebhookWrite = {
  source: "", name: "", description: "", events: [], handler: "record",
  client_code: "", require_signature: true, is_active: true,
};

/**
 * Register a webhook, or edit one — one form, opened from two places.
 *
 * The list creates (and then opens what it created); the detail screen edits the one
 * it is showing. It was the same JSX in both until the detail screen became a page:
 * two copies of a form whose fields decide what a partner may push is exactly the
 * kind of drift that ends with one of them accepting something the other refuses.
 */
export function WebhookFormModal({ open, editing, onClose, onSaved }: {
  open: boolean;
  /** The webhook being edited, or null to register a new one. */
  editing: Webhook | null;
  onClose: () => void;
  onSaved: (hook: Webhook, created: boolean) => void;
}) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<WebhookWrite>({ ...BLANK });
  const [problem, setProblem] = useState("");

  // Reloaded every time it opens, so a cancelled edit leaves nothing behind for the
  // next one to inherit.
  useEffect(() => {
    if (!open) return;
    setProblem("");
    setDraft(editing
      ? {
        source: editing.source, name: editing.name ?? "",
        description: editing.description ?? "", events: editing.events,
        handler: editing.handler, client_code: editing.client_code ?? "",
        require_signature: editing.require_signature, is_active: editing.is_active,
      }
      : { ...BLANK });
  }, [open, editing]);

  const handlers = useQuery({
    queryKey: ["apis", "webhook-handlers"], queryFn: webhooksApi.handlers,
    enabled: open,
  });
  const eventNames = useQuery({
    queryKey: ["apis", "webhook-events"], queryFn: webhooksApi.eventNames,
    enabled: open,
  });
  // The applications a webhook can be bound to. Same list the API console shows;
  // fetched here so the picker offers codes that actually authenticate.
  const clients = useQuery({
    queryKey: ["apis", "clients", "for-webhooks"],
    queryFn: () => integrationsApi.listClients({ size: 100 }),
    enabled: open,
  });

  const save = useMutation({
    mutationFn: (body: WebhookWrite) =>
      editing === null ? webhooksApi.create(body) : webhooksApi.update(editing.source, body),
    onSuccess: (hook) => {
      queryClient.invalidateQueries({ queryKey: ["apis", "webhooks"] });
      queryClient.invalidateQueries({ queryKey: ["apis", "webhook", hook.source] });
      toast.success(
        editing === null
          ? `${hook.source} registered — issue its secret next`
          : `${hook.source} saved`,
      );
      onSaved(hook, editing === null);
    },
    onError: (error) => setProblem(
      (error as { response?: { data?: { error?: string } } })?.response?.data?.error
      || "That webhook could not be saved.",
    ),
  });

  return (
    <Modal isOpen={open} onClose={onClose} size="lg" scrollBehavior="inside">
      <ModalContent>
        <ModalHeader className="font-display text-lg font-bold text-ink">
          <span className="flex items-center gap-2">
            <Radio className="h-5 w-5 text-brand" />
            {editing === null ? "Register a webhook" : `Edit ${editing.source}`}
          </span>
        </ModalHeader>
        <ModalBody className="gap-3">
          {problem && <ErrorBanner error={problem} />}
          {/* The same warning the application dialog gives, for the same reason:
              registering is step one of three, and nothing can push until the other
              two are done. */}
          {editing === null && (
            <p className="rounded-xl bg-content2 p-3 text-xs leading-relaxed text-muted">
              This creates the record only. Nothing can push until a signing secret is
              issued and the address is sent to them — both on the screen this opens
              next.
            </p>
          )}
          <Field label="Name" hint="What this system is called, for this screen.">
            <Input value={draft.name}
                   onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                   placeholder="HCM" />
          </Field>
          <Field
            label="URL name"
            hint={editing === null
              ? "Becomes part of the address they post to: /api/ext/v1/hooks/<name>. Lower case, letters, numbers and hyphens."
              : "Fixed once registered — changing it would break the address they are already posting to."}
          >
            <Input value={draft.source}
                   disabled={editing !== null}
                   onChange={(e) => setDraft({
                     ...draft, source: e.target.value.toLowerCase(),
                   })}
                   placeholder="hcm" />
          </Field>
          <Field
            label="Events it may send"
            hint="Search the list or type the sending system's own name. Anything not listed here is refused at push time, with the list of what it takes."
          >
            <EventPicker
              value={draft.events}
              options={eventNames.data ?? []}
              onChange={(events) => setDraft({ ...draft, events })}
            />
          </Field>
          <Field
            label="What SCM does with it"
            hint="A fixed list. Handling that writes to a business table is code, not configuration, so each option here answers for what it writes."
          >
            <Select
              value={draft.handler}
              onChange={(value) => setDraft({ ...draft, handler: value })}
              options={(handlers.data ?? []).map((h) => ({ value: h.key, label: h.label }))}
            />
          </Field>
          <Field
            label="Who may push"
            hint="The one application whose API key is accepted here. Leave it on any key only while wiring two sides together — every other registered client can reach this webhook until you set it."
          >
            <Select
              value={draft.client_code}
              onChange={(value) => setDraft({ ...draft, client_code: value })}
              options={[
                { value: "", label: "Any registered key" },
                ...(clients.data?.items ?? []).map((c) => ({
                  value: c.code, label: `${c.code} — ${c.name}`,
                })),
              ]}
            />
          </Field>
          <Field label="Description" hint="Optional.">
            <Input value={draft.description ?? ""}
                   onChange={(e) => setDraft({ ...draft, description: e.target.value })}
                   placeholder="Employee changes pushed from HCM" />
          </Field>
        </ModalBody>
        <ModalFooter>
          <Button variant="subtle" onClick={onClose}>Cancel</Button>
          <Button disabled={save.isPending || !draft.source.trim()
                            || !draft.name.trim() || !draft.events.length}
                  onClick={() => save.mutate(draft)}>
            {editing === null ? "Register" : "Save"}
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
