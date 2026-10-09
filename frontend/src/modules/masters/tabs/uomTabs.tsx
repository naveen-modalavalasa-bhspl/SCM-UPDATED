import { mastersApi } from "../api";
import { MasterCrud } from "../components/MasterCrud";
import type { Option } from "../components/MasterCrud";
import type { MasterUom, MasterUomConversion, UomClass } from "../types";
import { Button, Can, Card, Field, Select } from "@/shared/components";
import type { Column } from "@/shared/components";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Active, Code } from "./common";
import { UOM_CLASS_OPTS } from "./constants";



/** Pick a class, tick the standard units, create them in one call.
 *
 *  Typing units by hand is how "Litre", "litre" and "Ltr" end up as three rows that
 *  no conversion can reconcile. Offering the known names removes the chance. */

/** Pick a class, tick the standard units, create them in one call.
 *
 *  Typing units by hand is how "Litre", "litre" and "Ltr" end up as three rows that
 *  no conversion can reconcile. Offering the known names removes the chance. */
export function UomSuggestions() {
  const qc = useQueryClient();
  const [uomClass, setUomClass] = useState<UomClass>("TEMPERATURE");
  const [picked, setPicked] = useState<string[]>([]);

  const suggestions = useQuery({
    queryKey: ["masters", "uom-suggestions", uomClass],
    queryFn: () => mastersApi.uom.suggestions(uomClass),
  });
  const create = useMutation({
    mutationFn: () => mastersApi.uom.createSuggested(uomClass, picked),
    onSuccess: () => {
      setPicked([]);
      qc.invalidateQueries({ queryKey: ["masters", "uom"] });
      qc.invalidateQueries({ queryKey: ["masters", "uom-suggestions"] });
    },
  });

  const missing = (suggestions.data ?? []).filter((s) => !s.exists);
  return (
    <Card className="mb-4 p-4">
      <div className="flex flex-wrap items-end gap-3">
        <div className="w-56">
          <Field label="Measurement class">
            <Select value={uomClass} options={UOM_CLASS_OPTS}
                    onChange={(v) => { setUomClass(v as UomClass); setPicked([]); }} />
          </Field>
        </div>
        <Can do="master.uom.manage">
          <Button onClick={() => create.mutate()}
                  disabled={picked.length === 0 || create.isPending}>
            {create.isPending ? "Adding…" : `Add ${picked.length || ""} unit${picked.length === 1 ? "" : "s"}`.trim()}
          </Button>
        </Can>
      </div>

      {missing.length === 0 ? (
        <p className="mt-3 text-sm text-muted">
          Every standard {uomClass.toLowerCase()} unit already exists.
        </p>
      ) : (
        <div className="mt-3 flex flex-wrap gap-2">
          {missing.map((s) => {
            const on = picked.includes(s.code);
            return (
              <button key={s.code} type="button" aria-pressed={on}
                      onClick={() => setPicked((current) => on
                        ? current.filter((c) => c !== s.code)
                        : [...current, s.code])}
                      className={`min-h-11 rounded-xl border px-3 text-sm font-medium transition-colors ${
                        on ? "border-brand bg-brand-050 text-brand"
                           : "border-line bg-content1 text-body hover:bg-content2"
                      }`}>
                {s.name} <span className="mono text-xs text-muted">{s.code}</span>
              </button>
            );
          })}
        </div>
      )}
    </Card>
  );
}

/** The UOM types master as dropdown options, falling back to the built-in list
 *  while it loads or if it is empty. */
function useUomClassOptions(): Option[] {
  const q = useQuery({
    queryKey: ["masters", "uom-classes", "options"],
    queryFn: () => mastersApi.uomClasses.list({ size: 200 }).then((p) => p.items),
  });
  const rows = (q.data ?? []).filter((r) => r.is_active);
  return rows.length ? rows.map((r) => ({ value: r.code, label: r.name })) : UOM_CLASS_OPTS;
}

export function UomTab() {
  const classOpts = useUomClassOptions();
  const columns: Column<MasterUom>[] = [
    { key: "code", header: "Code", render: (r) => <Code>{r.code}</Code> },
    { key: "name", header: "Name", render: (r) => r.name },
    { key: "class", header: "Measures", render: (r) => r.uom_class },
    { key: "active", header: "Status", render: (r) => <Active on={r.is_active} /> },
  ];
  return (
    <>
      <UomSuggestions />
      <MasterCrud<MasterUom>
        title="UOM" queryKey="uom" managePerm="master.uom.manage"
        columns={columns}
        renderCard={(r) => (
          <div className="flex items-center justify-between">
            <div>
              <Code>{r.code}</Code>
              <span className="ml-2 text-sm text-body">{r.name}</span>
              <div className="text-xs text-muted">{r.uom_class}</div>
            </div>
            <Active on={r.is_active} />
          </div>
        )}
        fetchList={() => mastersApi.uom.listAll()}
        fields={[
          { key: "uom_class", label: "What it measures", type: "select",
            options: classOpts, required: true,
            hint: "Add more under Masters › UOM Types." },
          { key: "code", label: "Code", required: true, maxLength: 20,
            pattern: /^[A-Za-z0-9/]+$/,
            patternMessage: "Use letters, numbers or a slash" },
          { key: "name", label: "Name", required: true, maxLength: 100 },
          { key: "is_active", label: "Active", type: "switch" },
        ]}
        emptyForm={{ uom_class: "COUNT", code: "", name: "", is_active: true }}
        toForm={(r) => ({ uom_class: r.uom_class, code: r.code, name: r.name,
          is_active: r.is_active })}
        bulk={mastersApi.uom} usage={mastersApi.uom.usage}
        onCreate={(v) => mastersApi.uom.create(v as Partial<MasterUom>)}
        onUpdate={(id, v) => mastersApi.uom.update(id, v as Partial<MasterUom>)}
        onDeactivate={mastersApi.uom.deactivate}
      />
    </>
  );
}

export function ConversionsTab({ uoms }: { uoms: Option[] }) {
  const label = (id: number) => uoms.find((u) => u.value === id)?.label ?? `#${id}`;
  const columns: Column<MasterUomConversion>[] = [
    { key: "from", header: "From", render: (r) => label(r.from_uom_id) },
    { key: "to", header: "To", render: (r) => label(r.to_uom_id) },
    { key: "factor", header: "Factor", render: (r) => <Code>{r.factor}</Code> },
  ];
  return (
    <MasterCrud<MasterUomConversion>
      title="UOM conversion" queryKey="uom-conversions" managePerm="master.uom.manage"
      columns={columns}
      renderCard={(r) => (
        <div className="text-sm text-body">
          1 {label(r.from_uom_id)} = <Code>{r.factor}</Code> {label(r.to_uom_id)}
        </div>
      )}
      fetchList={() => mastersApi.uomConversions.listAll()}
      fields={[
        { key: "from_uom_id", label: "From UOM", type: "select", options: uoms, required: true },
        { key: "to_uom_id", label: "To UOM", type: "select", options: uoms, required: true },
        { key: "factor", label: "How many of 'to' in one 'from'", type: "number", required: true },
      ]}
      emptyForm={{ from_uom_id: null, to_uom_id: null, factor: null }}
      toForm={(r) => ({ from_uom_id: r.from_uom_id, to_uom_id: r.to_uom_id, factor: r.factor })}
      bulk={mastersApi.uomConversions}
      onCreate={(v) => mastersApi.uomConversions.create(v as Partial<MasterUomConversion>)}
      onUpdate={(id, v) => mastersApi.uomConversions.update(id, v as Partial<MasterUomConversion>)}
      /* mst_uom_conversions has no is_active column, so there is nothing to deactivate. */
    />
  );
}

/** The rung above BrandsTab: which brands sell this general name. Kept here rather
 *  than on a mapping screen for the same reason brands carry their manufacturers —
 *  a mapping you have to remember to go and make somewhere else does not get made. */
