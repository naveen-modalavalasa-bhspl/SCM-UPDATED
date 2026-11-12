import { Button, Can, ConfirmModal, ErrorBanner, Field, Input, PageHeader, Select, StatusPill } from "@/shared/components";
import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Chip, Progress } from "@heroui/react";
import { ArrowLeft, Check } from "lucide-react";
import { MetaCard, MetaRow, Section } from "../components/DocumentMeta";
import { LinesEditor, QtyInput, type LineColumn } from "../components/LinesEditor";
import { Lookup } from "../components/Lookup";
import {
  binOptions, completePicking, createPicking, employeeOptions, getIndentIssueSource,
  getPicking, indentOptions, itemOptions, pickLine, releasePicking, warehouseOptions,
} from "../api";
import { fmtQty, humanise, num, percent, today } from "../format";
import type { ItemOption, Picking, PickingItem, PickingWrite } from "../types";
import { usePointLabel } from "../usePointLabel";
import { TONE_MINT } from "@/shared/components/tones";

/**
 * A picklist: build it, release it, then pick it line by line.
 *
 * The screen is two different things depending on state, so it renders as two. A
 * draft is a form — pick the reference and the lines. A released picklist is a work
 * list: each line has a picked quantity and a confirm button, and each confirmation
 * is its own request so a picker who loses signal halfway has not lost the first
 * half of the trolley.
 */

const STRATEGIES = [
  { value: "FEFO", label: "FEFO — first expiring, first out" },
  { value: "FIFO", label: "FIFO — first in, first out" },
  { value: "MANUAL", label: "Manual" },
];

const REF_TYPES = [
  { value: "INDENT", label: "Indent" },
];

export default function PicklistForm() {
  const pointLabel = usePointLabel();
  const { id } = useParams();
  const nav = useNavigate();
  const qc = useQueryClient();
  const editing = !!id && id !== "new";

  const [form, setForm] = useState<PickingWrite>({
    pick_date: today(),
    warehouse_id: 0,
    ref_type: "INDENT",
    ref_id: null,
    strategy: "FEFO",
    assigned_to_id: null,
    items: [],
  });
  const [picked, setPicked] = useState<Record<number, number>>({});
  // The unit of each item picked on the draft, so its quantity box follows that unit.
  const [itemUom, setItemUom] = useState<Record<number, string | null>>({});
  const [confirming, setConfirming] = useState(false);

  const { data: doc, isLoading } = useQuery({
    queryKey: ["wh-picking", id],
    queryFn: () => getPicking(Number(id)),
    enabled: editing,
  });

  useEffect(() => {
    if (!doc) return;
    setPicked(Object.fromEntries((doc.items ?? []).map((l) => [l.id, num(l.picked_qty) || num(l.required_qty)])));
  }, [doc]);

  const set = <K extends keyof PickingWrite>(key: K, value: PickingWrite[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["wh-picking", id] });
    qc.invalidateQueries({ queryKey: ["wh-pickings"] });
  };

  const create = useMutation({
    mutationFn: () => createPicking(form),
    onSuccess: (saved: Picking) => {
      qc.invalidateQueries({ queryKey: ["wh-pickings"] });
      nav(`/warehouse/picklist/${saved.id}`, { replace: true });
    },
  });

  const pullIndent = useMutation({
    mutationFn: (indentId: number) => getIndentIssueSource(indentId, form.warehouse_id),
    onSuccess: (source) => {
      setForm((current) => ({
        ...current,
        ref_id: source.indent_id,
        items: source.items.map((line) => ({
          item_id: line.item_id,
          bin_id: line.bin_id,
          batch_id: line.batch_id,
          required_qty: line.issued_qty ?? line.requested_qty,
        })),
      }));
    },
  });

  const release = useMutation({ mutationFn: () => releasePicking(Number(id)), onSuccess: invalidate });

  const pick = useMutation({
    mutationFn: (line: PickingItem) =>
      pickLine(Number(id), line.id, picked[line.id] ?? num(line.required_qty), line.bin_id ?? undefined),
    onSuccess: invalidate,
  });

  const complete = useMutation({
    mutationFn: () => completePicking(Number(id)),
    onSuccess: (saved: Picking) => {
      invalidate();
      qc.invalidateQueries({ queryKey: ["wh-consignments"] });
      setConfirming(false);
      /* A pick raised off an issue has had its consignment raised for it by the
       * time this returns, so go there. A pick with no issue behind it (the older
       * pick-then-issue path) still goes to a new issue. */
      if (saved.ref_type === "ISSUE") nav("/warehouse/consignments");
      else nav(`/warehouse/material-issues/new?picking_id=${id}`);
    },
  });

  /* ------------------------------------------------------------ draft form -- */

  if (!editing) {
    const draftColumns: LineColumn<PickingWrite["items"][number]>[] = [
      {
        key: "item",
        header: "Item",
        render: (l, i) => (
          <Lookup
            name="items"
            load={itemOptions}
            value={l.item_id || ""}
            onChange={(v, option) => {
              setItemUom((c) => ({ ...c, [Number(v) || 0]: (option as ItemOption | undefined)?.uom_code ?? null }));
              set("items", form.items.map((r, x) => (x === i ? { ...r, item_id: v === "" ? 0 : v } : r)));
            }}
            placeholder="Pick an item"
          />
        ),
      },
      {
        key: "bin",
        header: "Bin",
        width: "w-44",
        render: (l, i) => (
          <Lookup
            name={`bins-${form.warehouse_id}`}
            load={(s) => binOptions(form.warehouse_id, s)}
            value={l.bin_id ?? ""}
            isDisabled={!form.warehouse_id}
            onChange={(v) =>
              set("items", form.items.map((r, x) => (x === i ? { ...r, bin_id: v === "" ? null : v } : r)))
            }
            placeholder="Any bin"
          />
        ),
      },
      {
        key: "qty",
        header: "Required",
        numeric: true,
        width: "w-28",
        render: (l, i) => (
          <QtyInput
            ariaLabel={`Required quantity, line ${i + 1}`}
            uom={itemUom[l.item_id]}
            value={l.required_qty}
            onChange={(v) =>
              set("items", form.items.map((r, x) => (x === i ? { ...r, required_qty: v } : r)))
            }
          />
        ),
      },
    ];

    return (
      <div>
        <PageHeader
          eyebrow={pointLabel}
          title="New material fulfilment"
          actions={
            <>
              <Button variant="ghost" onClick={() => nav("/warehouse/picklist")}>
                <ArrowLeft className="h-4 w-4" /> Back
              </Button>
              <Can do="issue.create">
                <Button className={TONE_MINT}
                  onClick={() => create.mutate()}
                  disabled={create.isPending || !form.warehouse_id || form.items.length === 0}
                >
                  {create.isPending ? "Creating…" : "Create fulfilment"}
                </Button>
              </Can>
            </>
          }
        />

        <ErrorBanner error={create.error ?? pullIndent.error} />

        <Section title="Material fulfilment">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Field label="Date">
              <Input type="date" value={form.pick_date} onChange={(e) => set("pick_date", e.target.value)} />
            </Field>
            <Field label="Warehouse">
              <Lookup
                name="warehouses"
                load={warehouseOptions}
                value={form.warehouse_id || ""}
                onChange={(v) => set("warehouse_id", v === "" ? 0 : v)}
                placeholder="Pick from"
              />
            </Field>
            <Field label="For">
              <Select
                value={form.ref_type ?? "INDENT"}
                onChange={(v) => set("ref_type", v)}
                options={REF_TYPES}
                ariaLabel="Reference type"
              />
            </Field>
            <Field label="Reference">
              <Lookup
                name={`indents-${form.warehouse_id}`}
                load={(search) => indentOptions(search, form.warehouse_id || undefined)}
                value={form.ref_id ?? ""}
                isDisabled={!form.warehouse_id || form.ref_type !== "INDENT"}
                onChange={(v) => {
                  const indentId = v === "" ? null : v;
                  set("ref_id", indentId);
                  if (indentId && form.ref_type === "INDENT") pullIndent.mutate(indentId);
                }}
                placeholder={form.warehouse_id ? "Document" : "Pick warehouse first"}
              />
            </Field>
            <Field label="Strategy" hint="FEFO is the default — expiring stock leaves first.">
              <Select
                value={form.strategy ?? "FEFO"}
                onChange={(v) => set("strategy", v)}
                options={STRATEGIES}
                ariaLabel="Picking strategy"
              />
            </Field>
            <Field label="Picker">
              <Lookup
                name="employees"
                load={employeeOptions}
                value={form.assigned_to_id ?? ""}
                onChange={(v) => set("assigned_to_id", v === "" ? null : v)}
                placeholder="Assign to"
              />
            </Field>
          </div>
        </Section>

        <Section title="Lines" hint="Leave the bin blank to let the strategy choose it.">
          <LinesEditor
            rows={form.items}
            columns={draftColumns}
            keyOf={(_, i) => i}
            onAdd={() => set("items", [...form.items, { item_id: 0, bin_id: null, batch_id: null, required_qty: 0 }])}
            onRemove={(i) => set("items", form.items.filter((_, x) => x !== i))}
            empty="Add the lines to pick."
          />
        </Section>
      </div>
    );
  }

  /* -------------------------------------------------------- released work -- */

  if (isLoading) return <div className="py-16 text-center text-muted">Loading…</div>;
  if (!doc) return <div className="py-16 text-center text-muted">Material fulfilment not found.</div>;

  const lines = doc.items ?? [];
  const progress = percent(doc.picked_lines, doc.total_lines);
  const working = ["RELEASED", "IN_PROGRESS"].includes(doc.status);

  const workColumns: LineColumn<PickingItem>[] = [
    {
      key: "item",
      header: "Item",
      render: (l) => (
        <div className="min-w-0">
          <div className="truncate font-mono text-xs font-semibold text-ink">{l.item_code ?? "—"}</div>
          <div className="truncate text-xs text-muted">{l.item_name ?? "—"}</div>
        </div>
      ),
    },
    {
      key: "bin",
      header: "From bin",
      render: (l) => (
        <div className="min-w-0">
          <Chip size="sm" variant="flat">{l.bin_code ?? "any"}</Chip>
          {l.batch_no && <div className="mt-0.5 truncate text-[11px] text-muted">batch {l.batch_no}</div>}
        </div>
      ),
    },
    {
      key: "required",
      header: "Required",
      numeric: true,
      width: "w-24",
      render: (l) => (
        <span className="tabular text-sm text-ink">{fmtQty(l.required_qty)} {l.uom_code ?? ""}</span>
      ),
    },
    {
      key: "picked",
      header: "Picked",
      numeric: true,
      width: "w-28",
      render: (l) => (
        <QtyInput
          ariaLabel={`Picked quantity for ${l.item_code ?? l.item_id}`}
          value={picked[l.id] ?? num(l.picked_qty)}
          max={num(l.required_qty)}
          disabled={!working || l.status === "PICKED"}
          onChange={(v) => setPicked((p) => ({ ...p, [l.id]: v }))}
        />
      ),
    },
    {
      key: "confirm",
      header: "",
      width: "w-32",
      render: (l) =>
        l.status === "PICKED" ? (
          <Chip size="sm" variant="flat" color="success" startContent={<Check className="h-3 w-3" />}>
            Picked
          </Chip>
        ) : (
          <Can do="picking.pick">
            <Button
              variant="subtle"
              onClick={() => pick.mutate(l)}
              disabled={!working || pick.isPending}
            >
              Confirm
            </Button>
          </Can>
        ),
    },
  ];

  return (
    <div>
      <PageHeader
        eyebrow={pointLabel}
        title={`Material fulfilment ${doc.pick_no}`}
        actions={
          <>
            <Button variant="ghost" onClick={() => nav("/warehouse/picklist")}>
              <ArrowLeft className="h-4 w-4" /> Back
            </Button>
            {doc.status === "DRAFT" && (
              <Can do="issue.create">
                <Button onClick={() => release.mutate()} disabled={release.isPending}>Release</Button>
              </Can>
            )}
            {working && (
              <Can do="picking.pick">
                <Button onClick={() => setConfirming(true)} disabled={doc.picked_lines === 0}>
                  Complete picking
                </Button>
              </Can>
            )}
          </>
        }
      />

      <ErrorBanner error={release.error ?? pick.error} />

      <MetaCard title="Material fulfilment">
        <MetaRow label="Number" value={<span className="font-mono">{doc.pick_no}</span>} />
        <MetaRow label="Status" value={<StatusPill status={doc.status} />} />
        <MetaRow label="For" value={`${humanise(doc.ref_type)} ${doc.ref_no ?? ""}`.trim()} />
        <MetaRow label="Warehouse" value={doc.warehouse_name} />
        <MetaRow label="Strategy" value={humanise(doc.strategy)} />
        <MetaRow label="Picker" value={doc.assigned_to_name} />
        <MetaRow
          label="Progress"
          value={
            <span className="block">
              <Progress
                size="sm"
                value={progress}
                aria-label={`${progress}% picked`}
                color={progress === 100 ? "success" : "primary"}
                className="mb-1 max-w-[160px]"
              />
              <span className="text-[11px] text-muted tabular">{doc.picked_lines}/{doc.total_lines}</span>
            </span>
          }
        />
      </MetaCard>

      <Section title="Lines">
        <LinesEditor
          rows={lines}
          columns={workColumns}
          keyOf={(l) => l.id}
          rowTone={(l) => (l.status === "PICKED" ? "bg-ok-bg/30" : undefined)}
          empty="This fulfilment has no lines."
        />
      </Section>

      <ConfirmModal
        isOpen={confirming}
        title="Complete picking?"
        message={`${doc.picked_lines} of ${doc.total_lines} lines are picked. Completing hands the fulfilment on; unpicked lines stay short.`}
        confirmLabel="Complete"
        busy={complete.isPending}
        error={complete.error}
        onConfirm={() => complete.mutate()}
        onClose={() => setConfirming(false)}
      />
    </div>
  );
}
