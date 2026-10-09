import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Modal, ModalBody, ModalContent, ModalFooter, ModalHeader, Switch,
} from "@heroui/react";
import { Layers, Pencil, Plus, Snowflake, Trash2 } from "lucide-react";
import {
  Button, Can, Card, ErrorBanner, Field, Input, PageHeader, ResponsiveList,
  type Column,
} from "@/shared/components";
import {
  createStorageType, deleteStorageType, listStorageTypes, seedStorageTypes,
  updateStorageType,
} from "../../api";
import type { StorageType, StorageTypeWrite } from "../../types";
import { activeTypes, byRung } from "../../storageTypes";
import { usePointLabel } from "../../usePointLabel";

/**
 * The storage-type master: what KINDS of location this company builds warehouses out of.
 *
 * This screen used to be "Refrigeration types" and carried a name, a code and a
 * description — a chiller's temperature band, nothing else. Everything ELSE about a
 * kind of location was hardcoded somewhere: the list of kinds in `shared/enums.py` and
 * again in `BinForm.tsx`, which kinds hold stock in a `BIN_TYPES` tuple, which kinds
 * are cold in a `isColdType` test on the code, and the shape of the building in a
 * `defaultChildType` ladder in the browser. The live data already used a kind
 * (STAGING) that the enum rejected, so those locations could be read and never saved.
 *
 * All of it is on this screen now, including the cold-chain kinds — a cold room is a
 * kind of storage location, not a separate idea.
 */

const EMPTY: StorageTypeWrite = {
  code: "",
  name: "",
  description: "",
  sort_order: 50,
  is_pickable: false,
  is_temperature_controlled: false,
  allow_top_level: false,
  is_active: true,
  parent_type_ids: [],
};

const toDraft = (row: StorageType): StorageTypeWrite => ({
  code: row.code ?? "",
  name: row.name,
  description: row.description ?? "",
  sort_order: row.sort_order ?? 0,
  is_pickable: row.is_pickable,
  is_temperature_controlled: row.is_temperature_controlled,
  allow_top_level: row.allow_top_level,
  is_active: row.is_active,
  parent_type_ids: [...row.parent_type_ids],
});

const clean = (draft: StorageTypeWrite): StorageTypeWrite => ({
  ...draft,
  code: draft.code?.trim().toUpperCase() || null,
  name: draft.name.trim(),
  description: draft.description?.trim() || null,
});



function Flag({ on, children }: { on: boolean; children: React.ReactNode }) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-semibold ${
        on ? "bg-ok-bg text-ok" : "bg-content2 text-muted"
      }`}
    >
      {children}
    </span>
  );
}

export default function StorageTypes() {
  const label = usePointLabel();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<StorageType | null>(null);
  const [draft, setDraft] = useState<StorageTypeWrite | null>(null);

  const query = useQuery({
    queryKey: ["wh-storage-types"],
    queryFn: listStorageTypes,
  });
  const rows = byRung(query.data ?? []);
  // A kind may sit inside any OTHER kind. Itself is left out: that is not a shape, it
  // is a ring the location tree would inherit, and the server refuses it anyway.
  const parentChoices = activeTypes(query.data ?? []).filter(
    (row) => !editing || row.id !== editing.id,
  );

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["wh-storage-types"] });
    // Every location screen labels its rows off this master.
    queryClient.invalidateQueries({ queryKey: ["wh-bins"] });
    queryClient.invalidateQueries({ queryKey: ["wh-locations"] });
  };

  const save = useMutation({
    mutationFn: () =>
      editing
        ? updateStorageType(editing.id, clean(draft!))
        : createStorageType(clean(draft!)),
    onSuccess: () => {
      invalidate();
      setEditing(null);
      setDraft(null);
    },
  });

  const remove = useMutation({
    mutationFn: (id: number) => deleteStorageType(id),
    onSuccess: invalidate,
  });

  const seed = useMutation({
    mutationFn: seedStorageTypes,
    onSuccess: invalidate,
  });

  const toggleParent = (id: number) => {
    if (!draft) return;
    const held = draft.parent_type_ids.includes(id);
    setDraft({
      ...draft,
      parent_type_ids: held
        ? draft.parent_type_ids.filter((row) => row !== id)
        : [...draft.parent_type_ids, id],
    });
  };

  const columns: Column<StorageType>[] = [
    {
      key: "name",
      header: "Type",
      render: (row) => (
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 font-semibold text-ink">
            {row.is_temperature_controlled && (
              <Snowflake className="h-3.5 w-3.5 shrink-0 text-info" />
            )}
            <span className="truncate">{row.name}</span>
          </div>
          <div className="font-mono text-[11px] text-muted">{row.code}</div>
        </div>
      ),
    },
    {
      key: "parents",
      header: "Sits inside",
      render: (row) =>
        row.parent_type_names.length
          ? row.parent_type_names.join(", ")
          : <span className="text-muted">Nothing — top level only</span>,
    },
    {
      key: "flags",
      header: "Behaviour",
      render: (row) => (
        <div className="flex flex-wrap gap-1">
          <Flag on={row.is_pickable}>
            {row.is_pickable ? "Holds stock" : "Structure"}
          </Flag>
          {row.allow_top_level && <Flag on>Top level</Flag>}
          {row.is_temperature_controlled && <Flag on>Cold chain</Flag>}
        </div>
      ),
    },
    {
      key: "location_count",
      header: "In use",
      render: (row) => (
        <span className="tabular text-sm">
          {row.location_count || <span className="text-muted">—</span>}
        </span>
      ),
    },
    {
      key: "is_active",
      header: "Status",
      render: (row) => (
        <span className={row.is_active ? "text-ok" : "text-muted"}>
          {row.is_active ? "Active" : "Inactive"}
        </span>
      ),
    },
    {
      key: "actions",
      header: "",
      render: (row) => (
        <Can do="master.location.manage">
          <div className="flex justify-end gap-1">
            <Button variant="ghost" onClick={() => { setEditing(row); setDraft(toDraft(row)); }}>
              <Pencil className="h-4 w-4" /> Edit
            </Button>
            {row.location_count === 0 && (
              <Button
                variant="ghost"
                onClick={() => remove.mutate(row.id)}
                aria-label={`Delete ${row.name}`}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            )}
          </div>
        </Can>
      ),
    },
  ];

  return (
    <div>
      <PageHeader
        eyebrow={`${label} master`}
        title="Storage types"
        actions={
          <Can do="master.location.manage">
            <>
              {rows.length === 0 && (
                <Button variant="subtle" onClick={() => seed.mutate()} disabled={seed.isPending}>
                  <Layers className="h-4 w-4" />
                  {seed.isPending ? "Loading…" : "Load the standard set"}
                </Button>
              )}
              <Button onClick={() => { setEditing(null); setDraft(EMPTY); }}>
                <Plus className="h-4 w-4" /> Add type
              </Button>
            </>
          </Can>
        }
      />

      <Card className="mb-4 p-4">
        <p className="text-sm leading-relaxed text-muted">
          Every storage location is one of these kinds, and a kind says where it sits —
          a shelf goes in a rack, a rack stands in a lane. That list is what the storage
          location form offers as a parent, so a bay can only ever be filed somewhere it
          could physically be. <strong className="text-body">Holds stock</strong> marks
          the kinds stock is counted and picked in; everything else is structure you
          walk past on the way to one.
        </p>
      </Card>

      <ErrorBanner error={query.error ?? remove.error ?? seed.error} />



      <ResponsiveList
        data={rows}
        columns={columns}
        keyOf={(row) => row.id}
        loading={query.isLoading}
        empty="No storage types yet. Load the standard set to get floors, lanes, racks, shelves, bins and cold rooms."
        renderCard={(row) => (
          <div className="space-y-1">
            <div className="flex items-center justify-between gap-2">
              <span className="font-semibold text-ink">{row.name}</span>
              <span className="font-mono text-[11px] text-muted">{row.code}</span>
            </div>
            <div className="text-[11px] text-muted">
              {row.parent_type_names.length
                ? `Sits inside ${row.parent_type_names.join(", ")}`
                : "Top level only"}
            </div>
            <div className="flex flex-wrap gap-1 pt-1">
              <Flag on={row.is_pickable}>
                {row.is_pickable ? "Holds stock" : "Structure"}
              </Flag>
              {row.is_temperature_controlled && <Flag on>Cold chain</Flag>}
            </div>
          </div>
        )}
      />

      <Modal
        isOpen={!!draft}
        onClose={() => { setDraft(null); setEditing(null); }}
        size="2xl"
        scrollBehavior="inside"
      >
        <ModalContent>
          <ModalHeader>{editing ? `Edit ${editing.name}` : "New storage type"}</ModalHeader>
          <ModalBody>
            <ErrorBanner error={save.error} />
            {draft && (
              <div className="space-y-5">
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                  <Field label="Type name" hint="Required">
                    <Input
                      value={draft.name}
                      onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                      placeholder="Carton bay"
                    />
                  </Field>
                  <Field label="Code" hint="Blank derives it from the name">
                    <Input
                      value={draft.code ?? ""}
                      onChange={(event) =>
                        setDraft({ ...draft, code: event.target.value.toUpperCase() })}
                      placeholder="CARTON_BAY"
                    />
                  </Field>
                  <Field
                    label="Rung order"
                    hint="How deep in the building. Floor 20, rack 40, bin 60."
                  >
                    <Input
                      type="number"
                      min="0"
                      value={String(draft.sort_order)}
                      onChange={(event) => setDraft({
                        ...draft,
                        sort_order: event.target.value === "" ? 0 : Number(event.target.value),
                      })}
                    />
                  </Field>
                </div>

                <Field label="Description">
                  <Input
                    value={draft.description ?? ""}
                    onChange={(event) =>
                      setDraft({ ...draft, description: event.target.value })}
                    placeholder="One level of a rack, or 2°C to 8°C for a chiller"
                  />
                </Field>

                <div>
                  <div className="text-[11px] font-semibold uppercase tracking-wider text-muted">
                    Sits inside
                  </div>
                  <p className="mb-2 mt-0.5 text-xs leading-relaxed text-muted">
                    Which kinds may hold a location of this kind. These are the only
                    parents the storage location form will offer. Tick none and it can
                    only stand at the top of a warehouse.
                  </p>
                  <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3">
                    {parentChoices.map((row) => {
                      const on = draft.parent_type_ids.includes(row.id);
                      return (
                        <button
                          key={row.id}
                          type="button"
                          onClick={() => toggleParent(row.id)}
                          aria-pressed={on}
                          className={`flex min-h-11 items-center gap-2 rounded-lg border px-2.5 py-1.5 text-left text-sm transition-colors ${
                            on
                              ? "border-brand-500 bg-brand-050 text-ink"
                              : "border-line bg-content1 text-body hover:bg-content2"
                          }`}
                        >
                          <span
                            className={`h-3.5 w-3.5 shrink-0 rounded border ${
                              on ? "border-brand-500 bg-brand-500" : "border-line"
                            }`}
                          />
                          <span className="truncate">{row.name}</span>
                        </button>
                      );
                    })}
                    {parentChoices.length === 0 && (
                      <p className="text-xs text-muted">
                        Nothing else is defined yet, so this kind starts at the top.
                      </p>
                    )}
                  </div>
                </div>

                <div className="space-y-3 rounded-xl border border-line bg-content2 p-4">
                  <label className="flex min-h-11 items-start gap-3">
                    <Switch
                      isSelected={draft.is_pickable}
                      onValueChange={(value) => setDraft({ ...draft, is_pickable: value })}
                    />
                    <span>
                      <span className="block text-sm font-medium text-body">Holds stock</span>
                      <span className="block text-xs text-muted">
                        Stock is counted and picked here. Off means structure you walk
                        past on the way to one.
                      </span>
                    </span>
                  </label>
                  <label className="flex min-h-11 items-start gap-3">
                    <Switch
                      isSelected={draft.is_temperature_controlled}
                      onValueChange={(value) =>
                        setDraft({ ...draft, is_temperature_controlled: value })}
                    />
                    <span>
                      <span className="block text-sm font-medium text-body">Cold chain</span>
                      <span className="block text-xs text-muted">
                        The location form asks for the temperature band and humidity.
                      </span>
                    </span>
                  </label>
                  <label className="flex min-h-11 items-start gap-3">
                    <Switch
                      isSelected={draft.allow_top_level}
                      onValueChange={(value) =>
                        setDraft({ ...draft, allow_top_level: value })}
                    />
                    <span>
                      <span className="block text-sm font-medium text-body">
                        May stand at the top
                      </span>
                      <span className="block text-xs text-muted">
                        A floor hangs off a block where there is one and stands on its
                        own where there is not.
                      </span>
                    </span>
                  </label>
                  <label className="flex min-h-11 items-center gap-3">
                    <Switch
                      isSelected={draft.is_active}
                      onValueChange={(value) => setDraft({ ...draft, is_active: value })}
                    />
                    <span className="text-sm">Active</span>
                  </label>
                </div>
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
