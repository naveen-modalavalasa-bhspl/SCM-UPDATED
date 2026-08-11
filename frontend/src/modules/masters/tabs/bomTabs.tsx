import { mastersApi } from "../api";
import { MasterCrud } from "../components/MasterCrud";
import type { FormField, Option } from "../components/MasterCrud";
import type {
  MasterBom, MasterBomGroup, MasterBomItem, MasterItemGroup,
} from "../types";
import { Button, Can, Card, Field, Input, Select } from "@/shared/components";
import { useAuth } from "@/shared/auth/AuthContext";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { Active, Code } from "./common";

/** A row with a validity window, as both BOM tabs carry it. */
interface Dated {
  effective_from?: string | null;
  effective_to?: string | null;
  is_effective?: boolean;
  is_active: boolean;
}

const day = (iso?: string | null) =>
  iso ? new Date(iso + "T00:00:00").toLocaleDateString(undefined, {
    day: "2-digit", month: "short", year: "numeric",
  }) : null;

/** The window in words. Blank ends are the common case, so the column says "Always"
 *  rather than leaving a dash the reader has to interpret. */
function Validity({ row }: { row: Dated }) {
  const from = day(row.effective_from);
  const to = day(row.effective_to);
  if (!from && !to) return <span className="text-muted">Always</span>;
  const text = from && to ? `${from} → ${to}` : from ? `From ${from}` : `Until ${to}`;
  // Off only because of its dates, not because someone switched it off: worth
  // saying, or a row reading "Active" while nothing can draw it looks like a bug.
  const dormant = row.is_active && row.is_effective === false;
  return (
    <span className={dormant ? "text-bad" : "text-body"}>
      {text}{dormant ? " · not in effect" : ""}
    </span>
  );
}

/** Both BOM tabs offer the same optional window, so it is written once. The two ends
 *  share one row: they are one setting, and reading them apart invites a window that
 *  ends before it starts.
 *
 *  Each end also bounds the other's calendar, so the picker cannot offer a day the
 *  pair forbids. The checks below still run — a date can be typed, not only picked,
 *  and the same rule is enforced again in `defs.check_validity_window`. */
const VALIDITY_FIELDS: FormField[] = [
  { key: "effective_from", label: "Active from", type: "date", half: true,
    hint: "Optional — leave both blank and it stays active all the time.",
    range: (all) => ({ max: (all.effective_to as string) || undefined }),
    validate: (value, all) =>
      value && all.effective_to && String(value) > String(all.effective_to)
        ? "Active from cannot be after Active to"
        : null },
  { key: "effective_to", label: "Active to", type: "date", half: true,
    range: (all) => ({ min: (all.effective_from as string) || undefined }),
    validate: (value, all) =>
      value && all.effective_from && String(value) < String(all.effective_from)
        ? "Active to cannot be before Active from"
        : null },
];

/** The window's two keys, blank in a new form and read back as blanks so a cleared
 *  date round-trips as "no bound" rather than as the string "null". */
const VALIDITY_EMPTY = { effective_from: "", effective_to: "" };
const validityForm = (r: Dated) => ({
  effective_from: r.effective_from ?? "", effective_to: r.effective_to ?? "",
});

/** The window as the API takes it. BOM groups build their body by hand — one form
 *  submit becomes one row per ticked BOM — so the two keys are picked out here
 *  instead of riding along with the rest of the form. */
const windowPayload = (v: Record<string, unknown>) => ({
  effective_from: (v.effective_from as string) || null,
  effective_to: (v.effective_to as string) || null,
});

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
          { key: "validity", header: "Valid", hideOnNarrow: true,
            render: (r) => <Validity row={r} /> },
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
            <div className="text-xs"><Validity row={r} /></div>
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
          ...VALIDITY_FIELDS,
          { key: "is_active", label: "Active", type: "switch",
            hint: "Switch this off to retire the BOM. Dates above pause it instead." },
        ]}
        emptyForm={{ code: "", name: "", project_id: null, description: "",
                     ...VALIDITY_EMPTY, is_active: true }}
        toForm={(r) => ({ code: r.code, name: r.name,
          project_id: r.project_id ?? null, description: r.description ?? "",
          ...validityForm(r), is_active: r.is_active })}
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

/** Who gets which kit. The BOM tab above says WHAT is in a kit; this says which job
 *  may draw it — so the two sit next to each other and share one permission.
 *
 *  The rung is the RBAC job profile, not an HCM role and not a position: a role is
 *  too coarse (one role covers fifteen unrelated jobs) and a position is one post in
 *  one village. Profiles are derived from the HCM mirror, so the dropdown is a live
 *  read rather than a list anyone maintains here. */
export function BomGroupsTab() {
  const { can } = useAuth();
  // The profile lookup is gated on the BOM permission, so asking for it without one
  // would 403 — and someone who is only reading the list has nothing to pick anyway.
  const mayManage = can("master.bom.manage");
  const boms = useQuery({
    queryKey: ["masters", "boms-all"],
    queryFn: () => mastersApi.boms.list({ size: 300 }).then((p) => p.items),
    enabled: mayManage,
  });
  const profiles = useQuery({
    queryKey: ["masters", "job-profiles"], queryFn: mastersApi.bomGroups.profiles,
    enabled: mayManage,
  });

  // Deactivated BOMs stay in the list, labelled: hiding them would blank the picker
  // on an existing row whose kit was since retired.
  const bomOpts: Option[] = (boms.data ?? []).map((b) => ({
    value: b.id,
    label: `${b.code} — ${b.name}${b.is_active ? "" : " (inactive)"}`,
  }));
  const profileOpts: Option[] = (profiles.data ?? []).map((p) => ({
    value: p.key,
    label: `${p.name} · ${p.project_name}`
      + (p.holder_count ? ` · ${p.holder_count} people` : ""),
  }));

  return (
    <>
      <div className="mb-3 rounded-xl bg-content2 px-4 py-3 text-sm text-muted">
        A BOM group hands a <strong className="text-body">kit to a job</strong> — the
        Store Keepers of one project get the store kit, the Drivers get the vehicle
        kit. The jobs come from{" "}
        <strong className="text-body">RBAC job profiles</strong>, so they follow the
        org: nothing is typed here and nothing to keep in step by hand.
      </div>
      {profiles.isError && (
        <div className="mb-3 rounded-xl bg-bad-bg px-4 py-3 text-sm text-bad">
          Could not load job profiles: {(profiles.error as Error).message}
        </div>
      )}
      <MasterCrud<MasterBomGroup>
        title="BOM group" queryKey="bom-groups" searchable
        managePerm="master.bom.manage" bulk={mastersApi.bomGroups}
        columns={[
          { key: "profile", header: "Job profile",
            render: (r) => r.profile_name ?? r.profile_key },
          { key: "project", header: "Project", hideOnNarrow: true,
            render: (r) => r.project_name ?? "Unassigned" },
          { key: "bom", header: "BOM", render: (r) => r.bom_name ?? "—" },
          { key: "code", header: "Code", hideOnNarrow: true,
            render: (r) => <Code>{r.bom_code}</Code> },
          { key: "validity", header: "Valid", hideOnNarrow: true,
            render: (r) => <Validity row={r} /> },
          { key: "active", header: "Status", render: (r) => <Active on={r.is_active} /> },
        ]}
        renderCard={(r) => (
          <div className="space-y-1">
            <div className="flex items-center justify-between">
              <span className="text-sm font-semibold text-ink">{r.profile_name}</span>
              <Active on={r.is_active} />
            </div>
            <div className="text-sm text-body">{r.bom_name}</div>
            <div className="text-xs text-muted">
              <Code>{r.bom_code}</Code> · {r.project_name ?? "Unassigned"}
            </div>
            <div className="text-xs"><Validity row={r} /></div>
          </div>
        )}
        fetchList={(search) =>
          mastersApi.bomGroups.list({ search, size: 300 }).then((p) => p.items)}
        fields={[
          { key: "profile_key", label: "Job profile", type: "select",
            options: profileOpts, required: true,
            placeholder: "Type a job or a project…",
            hint: "Everyone holding this job, in this project." },
          { key: "bom_ids", label: "BOMs", type: "multiselect", options: bomOpts,
            required: true,
            hint: "Tick every kit this job may draw — each becomes its own row." },
          { key: "remarks", label: "Remarks", maxLength: 500 },
          ...VALIDITY_FIELDS,
          { key: "is_active", label: "Active", type: "switch",
            hint: "Switch this off to retire the pairing. Dates above pause it instead." },
        ]}
        emptyForm={{ profile_key: "", bom_ids: [], remarks: "",
                     ...VALIDITY_EMPTY, is_active: true }}
        // One row is one pairing, so editing one shows its single BOM ticked. The
        // multiselect is there for the create, where handing a job six kits in one
        // pass beats opening the modal six times.
        toForm={(r) => ({ profile_key: r.profile_key, bom_ids: [r.bom_id],
          remarks: r.remarks ?? "", ...validityForm(r), is_active: r.is_active })}
        onCreate={async (v) => {
          const bomIds = Array.isArray(v.bom_ids) ? v.bom_ids : [];
          for (const bomId of bomIds) {
            await mastersApi.bomGroups.create({
              bom_id: Number(bomId), profile_key: String(v.profile_key),
              remarks: (v.remarks as string) || null,
              ...windowPayload(v),
              is_active: Boolean(v.is_active),
            });
          }
        }}
        onUpdate={(id, v) =>
          mastersApi.bomGroups.update(id, {
            bom_id: Number(Array.isArray(v.bom_ids) ? v.bom_ids[0] : v.bom_ids),
            profile_key: String(v.profile_key),
            remarks: (v.remarks as string) || null,
            ...windowPayload(v),
            is_active: Boolean(v.is_active),
          })}
        onDeactivate={mastersApi.bomGroups.deactivate}
      />
    </>
  );
}

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
