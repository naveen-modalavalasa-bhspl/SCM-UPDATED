import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Modal, ModalBody, ModalContent, ModalFooter, ModalHeader } from "@heroui/react";
import { ArrowUpRight, Plug } from "lucide-react";
import { Button, ErrorBanner, Field, Input, useToast } from "@/shared/components";
import { integrationsApi } from "../api";
import type { ApiClient, ClientWrite } from "../types";

const BLANK: ClientWrite = {
  code: "", name: "", description: "", contact_person: "", contact_email: "",
  is_active: true,
};

/**
 * Register an application, or edit one — one form, opened from two places, exactly as
 * `WebhookFormModal` is on the push side.
 *
 * The edit half was simply missing: an application was registered once and then no
 * screen could change its name, what it pulls, or who to call when it breaks, even
 * though `PUT /clients/{code}` had been there the whole time. An owner who leaves the
 * company stayed on the record forever.
 *
 * The CODE is the exception and is fixed after registering. Every key and endpoint is
 * filed under it, so the server refuses a rename rather than orphaning them — the
 * field says so and is disabled rather than letting the press fail.
 *
 * `is_active` is deliberately NOT a field here. Switching an application off refuses
 * its keys on somebody else's machine, which is not something to do halfway through
 * editing a contact email — it is its own press on the detail screen, with its own
 * question.
 */
export function ClientFormModal({ open, editing, onClose, onSaved }: {
  open: boolean;
  /** The application being edited, or null to register a new one. */
  editing: ApiClient | null;
  onClose: () => void;
  onSaved: (client: ApiClient, created: boolean) => void;
}) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<ClientWrite>({ ...BLANK });
  const [problem, setProblem] = useState("");

  // Reloaded every time it opens, so a cancelled edit leaves nothing behind for the
  // next one to inherit.
  useEffect(() => {
    if (!open) return;
    setProblem("");
    setDraft(editing
      ? {
        code: editing.code, name: editing.name,
        description: editing.description ?? "",
        contact_person: editing.contact_person ?? "",
        contact_email: editing.contact_email ?? "",
        is_active: editing.is_active,
      }
      : { ...BLANK });
  }, [open, editing]);

  const save = useMutation({
    mutationFn: (body: ClientWrite) =>
      editing === null
        ? integrationsApi.createClient(body)
        : integrationsApi.updateClient(editing.code, body),
    onSuccess: (client) => {
      queryClient.invalidateQueries({ queryKey: ["apis", "clients"] });
      queryClient.invalidateQueries({ queryKey: ["apis", "client", client.code] });
      toast.success(editing === null ? `${client.code} registered` : `${client.code} saved`);
      onSaved(client, editing === null);
    },
    onError: (error) => setProblem(
      (error as { response?: { data?: { error?: string } } })?.response?.data?.error
      || "That application could not be saved.",
    ),
  });

  const submit = () => {
    const code = draft.code.trim();
    const name = draft.name.trim();
    if (!code || !name) {
      setProblem("A code and a name are both required.");
      return;
    }
    setProblem("");
    save.mutate({ ...draft, code, name });
  };

  return (
    <Modal isOpen={open} onClose={onClose} size="lg" scrollBehavior="inside">
      <ModalContent>
        <ModalHeader className="font-display text-lg font-bold text-ink">
          <span className="flex items-center gap-2">
            <Plug className="h-5 w-5 text-brand" />
            {editing === null ? "Register an application" : `Edit ${editing.code}`}
          </span>
        </ModalHeader>
        <ModalBody>
          <div className="space-y-3">
            {/* Inside the dialog, not on the page behind it. A banner rendered under
                an open modal is invisible, so a rejected save looked like the button
                simply did nothing. */}
            {problem && <ErrorBanner error={problem} />}
            {editing === null && (
              <p className="rounded-xl bg-content2 p-3 text-xs leading-relaxed text-muted">
                This creates the record only. Nothing can call SCM until an API is
                built for it and a key is issued — both on the screen this opens next.
              </p>
            )}
            {/* Name first: it is the thing the person already knows. The code is a
                decision they make about it, and asking for the decision before the
                fact is why the field was being filled in twice. */}
            <Field label="Name" required>
              <Input value={draft.name} placeholder="e.g. Billing system"
                     onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
            </Field>
            <Field
              label="Code" required
              hint={editing === null
                ? "Short, upper case. It is the identity — keys and endpoints are filed under it and it cannot be changed later."
                : "Fixed once registered — every key and endpoint is filed under it."}
            >
              {/* Placeholders name no real system on purpose — this console serves
                  whatever gets connected, and an example that reads like one of them
                  suggests the screen is only for that one. */}
              <Input value={draft.code} placeholder="e.g. BILLING"
                     disabled={editing !== null}
                     onChange={(e) => setDraft({ ...draft, code: e.target.value })} />
            </Field>
            <Field label="What it pulls, and why">
              <Input value={draft.description ?? ""}
                     placeholder="e.g. Item master and stock on hand, to price jobs"
                     onChange={(e) => setDraft({ ...draft, description: e.target.value })} />
            </Field>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label="Owner" hint="Who to call when it starts failing.">
                <Input value={draft.contact_person ?? ""} placeholder="Name"
                       onChange={(e) => setDraft({ ...draft, contact_person: e.target.value })} />
              </Field>
              <Field label="Owner email">
                <Input value={draft.contact_email ?? ""} placeholder="name@company.com"
                       onChange={(e) => setDraft({ ...draft, contact_email: e.target.value })} />
              </Field>
            </div>
          </div>
        </ModalBody>
        <ModalFooter>
          <Button variant="subtle" onClick={onClose}>Cancel</Button>
          {/* Only ever disabled while the request is in flight. A button greyed out
              for a reason the screen does not state is indistinguishable from a broken
              one — so what is missing is said, on click, in a banner. */}
          <Button disabled={save.isPending} onClick={submit}>
            {editing === null
              ? <><ArrowUpRight className="h-4 w-4" /> Register and set it up</>
              : "Save"}
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
