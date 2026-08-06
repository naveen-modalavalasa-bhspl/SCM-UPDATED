import { mastersApi } from "../api";
import { MasterCrud } from "../components/MasterCrud";
import type { Option } from "../components/MasterCrud";
import type { MasterBom, MasterBomItem, MasterItemGroup } from "../types";
import { Button, Can, Card, Field, Input, Select } from "@/shared/components";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { Active, Code } from "./common";

/** Which items a user group may request. A group is defined by role or position in
 *  the RBAC module; this only decides its catalogue. */
export function ItemGroupsTab({ items }: { items: Option[] }) {
  const groups = useQuery({
    queryKey: ["masters", "user-groups"], queryFn: mastersApi.userGroups,
  });
  const groupOpts: Option[] = (groups.data ?? [])
    .map((g) => ({ value: g.id, label: g.code + " — " + g.name }));

  return (
    <>
      <div className="mb-3 rounded-xl bg-content2 px-4 py-3 text-sm text-muted">
        Tagging items to a group limits what its members can pick when raising a
        request. A group with <strong className="text-body">no items tagged</strong>{" "}
        sees the whole catalogue — nobody is ever left with an empty picker.
      </div>
      <MasterCrud<MasterItemGroup>
        title="User group mapping" queryKey="item-groups" searchable
        managePerm="master.item.manage" bulk={mastersApi.itemGroups}
        columns={[
          { key: "group", header: "Group", render: (r) => r.group_name ?? r.group_id },
          { key: "item", header: "Item", render: (r) => r.item_name ?? "—" },
          { key: "code", header: "Item code", hideOnNarrow: true,
            render: (r) => <Code>{r.item_code}</Code> },
          { key: "active", header: "Status", render: (r) => <Active on={r.is_active} /> },
        ]}
        renderCard={(r) => (
          <div className="space-y-1">
            <div className="flex items-center justify-between">
              <span className="text-sm font-semibold text-ink">{r.group_name}</span>
              <Active on={r.is_active} />
            </div>
            <div className="text-xs text-muted">{r.item_name}</div>
          </div>
        )}
        fetchList={(search) =>
          mastersApi.itemGroups.list({ search, size: 500 }).then((p) => p.items)}
        fields={[
          { key: "group_id", label: "User group", type: "select", options: groupOpts,
            required: true },
          { key: "item_ids", label: "Items", type: "multiselect", options: items,
            required: true },
          { key: "is_active", label: "Active", type: "switch" },
        ]}
        emptyForm={{ group_id: null, item_ids: [], is_active: true }}
        toForm={(r) => ({ group_id: r.group_id, item_ids: [r.item_id],
          is_active: r.is_active })}
        onCreate={async (v) => {
          const itemIds = Array.isArray(v.item_ids) ? v.item_ids : [];
          for (const itemId of itemIds) {
            await mastersApi.itemGroups.create({
              group_id: Number(v.group_id), item_id: Number(itemId),
              is_active: Boolean(v.is_active),
            });
          }
        }}
        onUpdate={(id, v) =>
          mastersApi.itemGroups.update(id, {
            group_id: Number(v.group_id),
            item_id: Number(Array.isArray(v.item_ids) ? v.item_ids[0] : v.item_ids),
            is_active: Boolean(v.is_active),
          })}
        onDeactivate={mastersApi.itemGroups.deactivate}
      />
    </>
  );
}

export function BomsTab({ projects }: { projects: Option[] }) {
  const qc = useQueryClient();
  return (
    <>
      <div className="mb-3 rounded-xl bg-content2 px-4 py-3 text-sm text-muted">
        A BOM is a <strong className="text-body">predefined set of items</strong> for a
        project — the standard kit a requester picks instead of typing the same lines
        every time.
      </div>
      <MasterCrud<MasterBom>
        title="BOM" queryKey="boms" searchable managePerm="master.bom.manage"
        bulk={mastersApi.boms}
        columns={[
          { key: "code", header: "Code", render: (r) => <Code>{r.code}</Code> },
          { key: "name", header: "Name", render: (r) => r.name },
          { key: "project", header: "Project", hideOnNarrow: true,
            render: (r) => r.project_name ?? "Any project" },
          { key: "lines", header: "Items", hideOnNarrow: true, render: (r) => r.total_items },
          { key: "active", header: "Status", render: (r) => <Active on={r.is_active} /> },
        ]}
        renderCard={(r) => (
          <div className="space-y-1">
            <div className="flex items-center justify-between">
              <Code>{r.code}</Code><Active on={r.is_active} />
            </div>
            <div className="text-sm text-body">{r.name}</div>
            <div className="text-xs text-muted">
              {r.project_name ?? "Any project"}
            </div>
          </div>
        )}
        fetchList={(search) => mastersApi.boms.list({ search, size: 200 }).then((p) => p.items)}
        fields={[
          { key: "code", label: "Code", required: true, maxLength: 50,
            pattern: /^[A-Za-z0-9-]+$/,
            patternMessage: "Use letters, numbers or a hyphen" },
          { key: "name", label: "Name", required: true, maxLength: 200 },
          { key: "project_id", label: "Project", type: "select", options: projects },
          { key: "description", label: "Description", maxLength: 500 },
          { key: "is_active", label: "Active", type: "switch" },
        ]}
        emptyForm={{ code: "", name: "", project_id: null, description: "",
                     is_active: true }}
        toForm={(r) => ({ code: r.code, name: r.name,
          project_id: r.project_id ?? null, description: r.description ?? "",
          is_active: r.is_active })}
        onCreate={async (v) => {
          const saved = await mastersApi.boms.create(v as Partial<MasterBom>);
          qc.invalidateQueries({ queryKey: ["masters", "boms-all"] });
          return saved;
        }}
        onUpdate={async (id, v) => {
          const saved = await mastersApi.boms.update(id, v as Partial<MasterBom>);
          qc.invalidateQueries({ queryKey: ["masters", "boms-all"] });
          return saved;
        }}
        onDeactivate={mastersApi.boms.deactivate}
      />
      <BomLines />
    </>
  );
}

/** The lines of one chosen BOM. Kept beside the header list rather than behind a
 *  row click, because building a kit means adding a dozen lines in a row. */

/** The lines of one chosen BOM. Kept beside the header list rather than behind a
 *  row click, because building a kit means adding a dozen lines in a row. */
export function BomLines() {
  const qc = useQueryClient();
  const [bomId, setBomId] = useState<string>("");
  const [lines, setLines] = useState<Array<{ item_id: string | number | ""; quantity: number | ""; remarks: string }>>([
    { item_id: "", quantity: 1, remarks: "" },
  ]);
  const [error, setError] = useState<string | null>(null);
  const boms = useQuery({
    queryKey: ["masters", "boms-all"],
    queryFn: () => mastersApi.boms.list({ size: 300 }).then((p) => p.items),
  });
  const items = useQuery({
    queryKey: ["masters", "items-all"],
    queryFn: () => mastersApi.items.list({ size: 300 }).then((p) => p.items),
  });
  const existingItems = useQuery({
    queryKey: ["masters", "bom-items-" + bomId, ""],
    queryFn: () => mastersApi.bomItems
      .list({ bom_id: Number(bomId), size: 300 }).then((p) => p.items),
    enabled: Boolean(bomId),
  });
  const bomOpts: Option[] = (boms.data ?? [])
    .map((b) => ({ value: b.id, label: b.code + " — " + b.name }));
  const itemOpts: Option[] = (items.data ?? [])
    .map((i) => ({ value: i.id, label: i.code + " — " + i.name }));
  const existingItemIds = new Set(
    (existingItems.data ?? []).map((line) => String(line.item_id)),
  );
  const nextLineNo = Math.max(
    0,
    ...(existingItems.data ?? []).map((line) => line.line_no),
  ) + 1;
  const selectedItemIds = lines
    .filter((line) => line.item_id !== "")
    .map((line) => String(line.item_id));
  const repeatedItemId = selectedItemIds.find(
    (itemId, index) => selectedItemIds.indexOf(itemId) !== index,
  );
  const alreadyInTemplateId = selectedItemIds.find(
    (itemId) => existingItemIds.has(itemId),
  );
  const batchError = repeatedItemId
    ? "The same item cannot be added twice in one batch."
    : alreadyInTemplateId
      ? "That item is already in this template."
      : null;
  const validLines = lines.filter(
    (line) => line.item_id !== "" && line.quantity !== "" && Number(line.quantity) > 0,
  );
  const addLines = useMutation({
    mutationFn: async () => {
      if (batchError) throw new Error(batchError);
      if (validLines.length !== selectedItemIds.length) {
        throw new Error("Quantity must be greater than zero for every selected item.");
      }
      for (const [index, line] of validLines.entries()) {
        await mastersApi.bomItems.create({
          bom_id: Number(bomId),
          item_id: Number(line.item_id),
          line_no: nextLineNo + index,
          quantity: Number(line.quantity),
          remarks: line.remarks || null,
        });
      }
    },
    onSuccess: () => {
      setLines([{ item_id: "", quantity: 1, remarks: "" }]);
      setError(null);
      qc.invalidateQueries({ queryKey: ["masters", "bom-items-" + bomId] });
      qc.invalidateQueries({ queryKey: ["masters", "boms"] });
      qc.invalidateQueries({ queryKey: ["masters", "boms-all"] });
    },
    onError: (reason: Error) => {
      setError(reason.message);
      // Earlier rows may already have been accepted before a later row failed.
      // Refresh immediately so the next attempt continues from the real last line.
      qc.invalidateQueries({ queryKey: ["masters", "bom-items-" + bomId] });
    },
  });
  const setLine = (
    index: number,
    patch: Partial<{ item_id: string | number | ""; quantity: number | ""; remarks: string }>,
  ) => {
    setError(null);
    setLines((current) =>
      current.map((line, i) => (i === index ? { ...line, ...patch } : line)));
  };
  const selectBom = (value: string) => {
    setBomId(value);
    setLines([{ item_id: "", quantity: 1, remarks: "" }]);
    setError(null);
  };

  return (
    <div className="mt-8 border-t border-line pt-6">
      <div className="mb-4 max-w-sm">
        <Field label="Show the items in">
          <Select value={bomId} options={bomOpts} placeholder="Pick a BOM…"
                  onChange={selectBom} />
        </Field>
      </div>
      {!bomId ? (
        <p className="text-sm text-muted">Pick a BOM to see and edit its items.</p>
      ) : (
        <>
        <Card className="mb-5 p-4">
          <div className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted">
            Add template items
          </div>
          <div className="space-y-3">
            {lines.map((line, index) => {
              const selected = (items.data ?? [])
                .find((item) => String(item.id) === String(line.item_id));
              const selectedInOtherRows = new Set(
                lines
                  .filter((_, otherIndex) => otherIndex !== index)
                  .map((otherLine) => String(otherLine.item_id)),
              );
              const availableItemOpts = itemOpts.filter((option) => {
                const optionId = String(option.value);
                return optionId === String(line.item_id)
                  || (!existingItemIds.has(optionId) && !selectedInOtherRows.has(optionId));
              });
              return (
                <div key={index}
                     className="grid gap-3 rounded-xl border border-line bg-content1 p-3 md:grid-cols-[1fr_120px_1fr_44px] md:items-end">
                  <Field label={index === 0 ? "Item" : ""}>
                    <Select value={line.item_id} options={availableItemOpts}
                            placeholder="Type item code or name"
                            onChange={(value) => setLine(index, { item_id: value })} />
                  </Field>
                  <Field label={index === 0 ? "Qty" : ""}>
                    <Input type="number" min={0} step="0.001"
                           value={String(line.quantity)}
                           onChange={(e) => setLine(index, {
                             quantity: e.target.value ? Number(e.target.value) : "",
                           })} />
                  </Field>
                  <Field label={index === 0 ? "Remarks" : ""}>
                    <Input value={line.remarks}
                           placeholder={selected?.uom_code ? `UOM: ${selected.uom_code}` : "Optional"}
                           onChange={(e) => setLine(index, { remarks: e.target.value })} />
                  </Field>
                  <button type="button"
                          onClick={() => setLines((current) =>
                            current.filter((_, i) => i !== index))}
                          disabled={lines.length === 1}
                          className="grid h-11 w-11 place-items-center rounded-lg text-muted hover:bg-bad-bg hover:text-bad disabled:opacity-30"
                          aria-label="Remove line">
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              );
            })}
          </div>
          <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
            <button type="button"
                    onClick={() => setLines((current) => [
                      ...current, { item_id: "", quantity: 1, remarks: "" },
                    ])}
                    className="inline-flex items-center gap-2 text-sm font-semibold text-brand">
              <Plus className="h-4 w-4" /> Add line
            </button>
            <Can do="master.bom.manage">
              <Button disabled={
                        validLines.length === 0 || Boolean(batchError)
                        || addLines.isPending || existingItems.isFetching
                      }
                      onClick={() => addLines.mutate()}>
                {addLines.isPending ? "Adding..." : "Add items to template"}
              </Button>
            </Can>
          </div>
          {(batchError || error) && (
            <div className="mt-3 rounded-lg bg-bad-bg px-3 py-2 text-sm text-bad">
              {batchError || error}
            </div>
          )}
        </Card>
        <MasterCrud<MasterBomItem>
          key={`${bomId}-${nextLineNo}`}
          title="Template item" queryKey={"bom-items-" + bomId}
          managePerm="master.bom.manage"
          columns={[
            { key: "line", header: "#", render: (r) => r.line_no },
            { key: "item", header: "Item", render: (r) => r.item_name ?? "—" },
            { key: "code", header: "Code", hideOnNarrow: true,
              render: (r) => <Code>{r.item_code}</Code> },
            { key: "qty", header: "Quantity",
              render: (r) => [r.quantity, r.uom_code ?? ""].join(" ").trim() },
            { key: "remarks", header: "Remarks", hideOnNarrow: true,
              render: (r) => r.remarks ?? "—" },
          ]}
          renderCard={(r) => (
            <div>
              <div className="text-sm text-body">{r.item_name}</div>
              <div className="text-xs text-muted">{r.quantity} {r.uom_code}</div>
            </div>
          )}
          fetchList={() => mastersApi.bomItems
            .list({ bom_id: Number(bomId), size: 300 }).then((p) => p.items)}
          fields={[
            { key: "item_id", label: "Item", type: "select", options: itemOpts,
              required: true },
            { key: "line_no", label: "Line number", type: "number", min: 1 },
            { key: "quantity", label: "Quantity", type: "number", min: 0,
              required: true },
            { key: "remarks", label: "Remarks", maxLength: 500 },
          ]}
          emptyForm={{ item_id: null, line_no: nextLineNo, quantity: 1, remarks: "" }}
          toForm={(r) => ({ item_id: r.item_id, line_no: r.line_no,
            quantity: r.quantity, remarks: r.remarks ?? "" })}
          bulk={mastersApi.bomItems}
          onCreate={(v) => mastersApi.bomItems.create({
            ...(v as Partial<MasterBomItem>), bom_id: Number(bomId) })}
          onUpdate={(id, v) => mastersApi.bomItems.update(id, {
            ...(v as Partial<MasterBomItem>), bom_id: Number(bomId) })}
        />
        </>
      )}
    </div>
  );
}

/** Read-only HCM mirrors (rule 10 — sync owns those tables). */
