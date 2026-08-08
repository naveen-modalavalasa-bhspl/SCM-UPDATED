import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Modal, ModalBody, ModalContent, ModalFooter, ModalHeader, Switch } from "@heroui/react";
import { Pencil, Plus } from "lucide-react";
import { Button, Can, Card, ErrorBanner, Field, Input, PageHeader } from "@/shared/components";
import { createStorageType, listStorageTypes, updateStorageType } from "../../api";
import type { StorageType, StorageTypeWrite } from "../../types";
import { usePointLabel } from "../../usePointLabel";

const EMPTY: StorageTypeWrite = {
  code: "",
  name: "",
  description: "",
  is_active: true,
};

export default function StorageTypes() {
  const label = usePointLabel();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<StorageType | null>(null);
  const [draft, setDraft] = useState<StorageTypeWrite | null>(null);

  const query = useQuery({
    queryKey: ["wh-storage-types"],
    queryFn: listStorageTypes,
  });

  const save = useMutation({
    mutationFn: () => (
      editing
        ? updateStorageType(editing.id, {
            ...draft!,
            code: draft!.code?.trim() || null,
            name: draft!.name.trim(),
            description: draft!.description?.trim() || null,
          })
        : createStorageType({
            ...draft!,
            code: draft!.code?.trim() || null,
            name: draft!.name.trim(),
            description: draft!.description?.trim() || null,
          })
    ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["wh-storage-types"] });
      setEditing(null);
      setDraft(null);
    },
  });

  const openEdit = (row: StorageType) => {
    setEditing(row);
    setDraft({
      code: row.code ?? "",
      name: row.name,
      description: row.description ?? "",
      is_active: row.is_active,
    });
  };

  return (
    <div>
      <PageHeader
        eyebrow={`${label} master`}
        title="Refrigeration types"
        actions={
          <Can do="master.location.manage">
            <Button onClick={() => setDraft(EMPTY)}>
              <Plus className="h-4 w-4" /> Add type
            </Button>
          </Can>
        }
      />
      <ErrorBanner error={query.error} />
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
        {(query.data ?? []).map((row) => (
          <Card key={row.id} className="p-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="font-semibold text-ink">{row.name}</div>
                {row.code && <div className="mt-0.5 font-mono text-xs text-muted">{row.code}</div>}
                <div className="mt-1 text-sm text-muted">
                  {row.description || "No default temperature notes."}
                </div>
                <div className="mt-2 text-xs text-muted">
                  {row.is_active ? "Active" : "Inactive"}
                </div>
              </div>
              <Can do="master.location.manage">
                <Button variant="ghost" onClick={() => openEdit(row)}>
                  <Pencil className="h-4 w-4" /> Edit
                </Button>
              </Can>
            </div>
          </Card>
        ))}
      </div>

      <Modal isOpen={!!draft} onClose={() => { setDraft(null); setEditing(null); }}>
        <ModalContent>
          <ModalHeader>{editing ? `Edit ${editing.name}` : "New refrigeration type"}</ModalHeader>
          <ModalBody>
            <ErrorBanner error={save.error} />
            {draft && (
              <div className="space-y-4">
                <Field label="Type code">
                  <Input
                    value={draft.code ?? ""}
                    onChange={(event) => setDraft({ ...draft, code: event.target.value.toUpperCase() })}
                    placeholder="CHILLER_2_8C"
                  />
                </Field>
                <Field label="Type name">
                  <Input
                    value={draft.name}
                    onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                    placeholder="Cold storage rack"
                  />
                </Field>
                <Field label="Default temperature range and description">
                  <Input
                    value={draft.description ?? ""}
                    onChange={(event) => setDraft({ ...draft, description: event.target.value })}
                    placeholder="2°C to 8°C"
                  />
                </Field>
                <label className="flex min-h-11 items-center gap-3">
                  <Switch
                    isSelected={draft.is_active}
                    onValueChange={(value) => setDraft({ ...draft, is_active: value })}
                  />
                  <span className="text-sm">Active</span>
                </label>
              </div>
            )}
          </ModalBody>
          <ModalFooter>
            <Button variant="subtle" onClick={() => { setDraft(null); setEditing(null); }}>
              Cancel
            </Button>
            <Button
              onClick={() => save.mutate()}
              disabled={!draft?.name.trim() || save.isPending}
            >
              {save.isPending ? "Saving…" : "Save type"}
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>
    </div>
  );
}
