import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2 } from "lucide-react";
import { CardBody } from "@heroui/react";
import { PageHeader, Button, Card, Field, Input, Select } from "@/shared/components";
import { useAuth } from "@/shared/auth/AuthContext";
import {
  indentApi, indentKeys, isIndentModuleQuery, masterApi,
  useIndentAccountCacheIsolation, useIndentAccountScope,
} from "../api";
import { ItemCombobox } from "../components/ItemCombobox";

interface Line {
  item_id: number | "";
  quantity: number | "";
}

const PAST_REQUIRED_DATE_ERROR = "Required date cannot be earlier than today";
const UOM_UNAVAILABLE = "UOM unavailable";

function localDateString(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function IndentFormPage() {
  const nav = useNavigate();
  const { me } = useAuth();
  const accountScope = useIndentAccountScope();
  useIndentAccountCacheIsolation(accountScope);
  const qc = useQueryClient();
  const [priority, setPriority] = useState("NORMAL");
  const [requiredDate, setRequiredDate] = useState("");
  const [remarks, setRemarks] = useState("");
  const [lines, setLines] = useState<Line[]>([{ item_id: "", quantity: "" }]);
  const [itemSearch, setItemSearch] = useState("");
  const [debouncedItemSearch, setDebouncedItemSearch] = useState("");
  const [error, setError] = useState<string | null>(null);
  const today = localDateString();
  const requiredDateError = requiredDate && requiredDate < today
    ? PAST_REQUIRED_DATE_ERROR
    : null;

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedItemSearch(itemSearch.trim()), 300);
    return () => window.clearTimeout(timer);
  }, [itemSearch]);

  const { data: items = [], isFetching: itemsLoading } = useQuery({
    queryKey: indentKeys.items(accountScope, ["form", debouncedItemSearch]),
    queryFn: () => masterApi.items(debouncedItemSearch),
    enabled: debouncedItemSearch.length >= 2,
  });

  const create = useMutation({
    mutationFn: () =>
      indentApi.create({
        priority,
        required_date: requiredDate || null,
        remarks: remarks || null,
        items: lines
          .filter((l) => l.item_id !== "" && l.quantity !== "")
          .map((l) => ({ item_id: Number(l.item_id), quantity: Number(l.quantity) })),
    }),
    onSuccess: (indent) => {
      qc.invalidateQueries({ predicate: isIndentModuleQuery });
      nav(`/indents/${indent.id}`);
    },
    onError: (e: Error) => setError(e.message),
  });

  const setLine = (i: number, patch: Partial<Line>) =>
    setLines((ls) => ls.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));
  const validLines = lines.filter((l) => l.item_id !== "" && l.quantity !== "");

  const itemOptions = items.map((it) => ({ value: it.id, label: `${it.code} — ${it.name}` }));

  return (
    <>
      <PageHeader eyebrow="Indent" title="New request" />

      <div className="grid gap-5 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardBody className="p-5">
            <h2 className="mb-4 text-sm font-semibold uppercase tracking-wider text-muted">Line items</h2>
            <div className="space-y-4">
              {lines.map((line, i) => {
                const selectedItem = items.find((it) => Number(it.id) === Number(line.item_id));
                const uom = selectedItem?.uom_code?.trim() || (selectedItem ? UOM_UNAVAILABLE : "");
                const quantityLabel = selectedItem
                  ? `Quantity (${uom})`
                  : "Quantity";
                return (
                  <div key={i} className="space-y-1.5 p-3 rounded-xl bg-content2/50 border border-line/40">
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_120px_44px] sm:items-end">
                      <Field label={i === 0 ? "Item" : ""}>
                        <ItemCombobox
                          placeholder="Type item code or name…"
                          value={line.item_id}
                          onChange={(value) => setLine(i, { item_id: value })}
                          onQueryChange={setItemSearch}
                          options={itemOptions}
                          isLoading={itemsLoading}
                        />
                      </Field>
                      <Field label={i === 0 ? "Qty" : ""}>
                        <Input
                          type="number"
                          min={0}
                          step="0.001"
                          aria-label={quantityLabel}
                          value={String(line.quantity)}
                          onChange={(e) => setLine(i, { quantity: e.target.value ? Number(e.target.value) : "" })}
                          {...(uom ? {
                            endContent: (
                              <span className="max-w-20 truncate pl-2 text-xs font-medium text-muted" title={uom}>
                                {uom}
                              </span>
                            ),
                          } : {})}
                        />
                      </Field>
                      <button
                        onClick={() => setLines((ls) => ls.filter((_, idx) => idx !== i))}
                        disabled={lines.length === 1}
                        className="grid h-11 w-11 place-items-center rounded-xl text-muted hover:bg-bad-bg hover:text-bad disabled:opacity-30"
                        aria-label="Remove line"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>

                    {selectedItem && (
                      <div className="flex items-center justify-between text-xs px-1 text-muted">
                        <span>Category / Sub-spec: <strong className="text-ink font-mono">{selectedItem.code}</strong></span>
                        <span className="inline-flex items-center gap-1 rounded bg-neutral-bg px-2 py-0.5 font-semibold text-neutral">
                          Stock availability not checked
                        </span>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
            <button
              onClick={() => setLines((ls) => [...ls, { item_id: "", quantity: "" }])}
              className="mt-4 inline-flex items-center gap-2 text-sm font-semibold text-brand hover:text-brand-600"
            >
              <Plus className="h-4 w-4" /> Add line
            </button>
          </CardBody>
        </Card>

        <div className="space-y-5">
          <Card className="h-fit">
            <CardBody className="gap-4 p-5">
              <h2 className="text-sm font-semibold uppercase tracking-wider text-muted">Details</h2>
              <Field label="Priority">
                <Select
                  value={priority}
                  onChange={(v) => setPriority(v || "NORMAL")}
                  options={[{ value: "NORMAL", label: "Normal" }, { value: "URGENT", label: "Urgent" }]}
                />
              </Field>
              <Field label="Required date">
                <Input
                  type="date"
                  min={today}
                  value={requiredDate}
                  aria-invalid={requiredDateError ? "true" : undefined}
                  aria-describedby={requiredDateError ? "required-date-error" : undefined}
                  onChange={(e) => setRequiredDate(e.target.value)}
                />
                {requiredDateError && (
                  <span id="required-date-error" className="mt-1 block text-xs font-medium text-bad">
                    {requiredDateError}
                  </span>
                )}
              </Field>
              <Field label="Raised as">
                <Input value={me?.active_position?.name ?? "No position assigned"} disabled />
              </Field>
              <Field label="Delivery location">
                <Select
                  placeholder="Office is assigned from your position"
                  value={me?.active_position?.office_id ?? me?.employee.office_id ?? ""}
                  onChange={() => undefined}
                  isDisabled
                  options={(me?.active_position?.office_id ?? me?.employee.office_id) ? [{
                    value: me?.active_position?.office_id ?? me!.employee.office_id!,
                    label: me?.active_position?.office_name
                      ?? me?.employee.office_name
                      ?? "Tagged office",
                  }] : []}
                />
              </Field>
              <Field label="Remarks">
                <Input value={remarks} onChange={(e) => setRemarks(e.target.value)} placeholder="Optional" />
              </Field>
            </CardBody>
          </Card>

          <Card>
            <CardBody className="gap-3 p-5">
              <h2 className="text-sm font-semibold uppercase tracking-wider text-muted">Attachments</h2>
              <p className="rounded-lg border border-dashed border-line px-3 py-3 text-center text-xs text-muted">
                Attachments are not available for new indents yet.
              </p>
            </CardBody>
          </Card>
        </div>
      </div>

      {error && (
        <div className="mt-4 rounded-xl bg-bad-bg px-4 py-3 text-sm font-medium text-bad">{error}</div>
      )}

      <div className="fixed inset-x-0 bottom-0 z-10 flex gap-3 border-t border-line bg-content1 p-4 pb-[calc(env(safe-area-inset-bottom)+1rem)] md:static md:mt-6 md:justify-end md:border-0 md:bg-transparent md:p-0">
        <Button variant="subtle" className="flex-1 md:flex-none" onClick={() => nav("/indents")}>
          Cancel
        </Button>
        <Button
          className="flex-1 md:flex-none"
          disabled={validLines.length === 0 || Boolean(requiredDateError) || create.isPending}
          onClick={() => {
            setError(null);
            if (requiredDateError) return;
            create.mutate();
          }}
        >
          {create.isPending ? "Creating…" : "Create indent"}
        </Button>
      </div>
    </>
  );
}
