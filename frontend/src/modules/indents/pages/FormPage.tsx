import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2 } from "lucide-react";
import { CardBody } from "@heroui/react";
import { PageHeader, Button, Card, Field, Input, Select } from "@/shared/components";
import { useAuth } from "@/shared/auth/AuthContext";
import { indentApi, masterApi } from "../api";
import { ItemCombobox } from "../components/ItemCombobox";

interface Line {
  item_id: number | "";
  quantity: number | "";
}

export function IndentFormPage() {
  const nav = useNavigate();
  const { me } = useAuth();
  const qc = useQueryClient();
  const [priority, setPriority] = useState("NORMAL");
  const [requiredDate, setRequiredDate] = useState("");
  const [remarks, setRemarks] = useState("");
  const [lines, setLines] = useState<Line[]>([{ item_id: "", quantity: "" }]);
  const [error, setError] = useState<string | null>(null);

  const { data: items = [] } = useQuery({ queryKey: ["items"], queryFn: () => masterApi.items() });

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
      qc.invalidateQueries({ queryKey: ["indents"] });
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
      <PageHeader eyebrow="Material Requests" title="New request" />

      <div className="grid gap-5 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardBody className="p-5">
            <h2 className="mb-4 text-sm font-semibold uppercase tracking-wider text-muted">Line items</h2>
            <div className="space-y-3">
              {lines.map((line, i) => (
                <div key={i} className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_120px_44px] sm:items-end">
                  <Field label={i === 0 ? "Item" : ""}>
                    <ItemCombobox
                      placeholder="Type item code or name…"
                      value={line.item_id}
                      onChange={(value) => setLine(i, { item_id: value })}
                      options={itemOptions}
                    />
                  </Field>
                  <Field label={i === 0 ? "Qty" : ""}>
                    <Input
                      type="number"
                      min={0}
                      step="0.001"
                      value={String(line.quantity)}
                      onChange={(e) => setLine(i, { quantity: e.target.value ? Number(e.target.value) : "" })}
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
              ))}
            </div>
            <button
              onClick={() => setLines((ls) => [...ls, { item_id: "", quantity: "" }])}
              className="mt-3 inline-flex items-center gap-2 text-sm font-semibold text-brand hover:text-brand-600"
            >
              <Plus className="h-4 w-4" /> Add line
            </button>
          </CardBody>
        </Card>

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
              <Input type="date" value={requiredDate} onChange={(e) => setRequiredDate(e.target.value)} />
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
          disabled={validLines.length === 0 || create.isPending}
          onClick={() => { setError(null); create.mutate(); }}
        >
          {create.isPending ? "Creating…" : "Create indent"}
        </Button>
      </div>
    </>
  );
}
