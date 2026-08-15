import { useQuery } from "@tanstack/react-query";
import { Trash2 } from "lucide-react";
import { Button, Card, Field, Select } from "@/shared/components";
import { integrationsApi } from "../api";
import type { JoinDef, SourceColumn, SourceTable } from "../types";

/**
 * One extra source table. Fetches its own columns so the parent form does not have to
 * juggle a query per table — a table added and removed again would otherwise leave a
 * stale column list behind.
 *
 * `from_index` is the interesting control: it decides WHICH table this one joins to.
 * -1 is the base table, 0 the first extra table, and so on. Only tables added before
 * this one are offered, so a chain can never point at itself.
 */
export function JoinEditor({
  index, join, joins, baseTable, columnsOf, tables, onChange, onRemove,
}: {
  index: number;
  join: JoinDef;
  joins: JoinDef[];
  baseTable: string;
  /** Columns of any table already in the endpoint, keyed by from_index. */
  columnsOf: (fromIndex: number) => SourceColumn[];
  tables: SourceTable[];
  onChange: (next: JoinDef) => void;
  onRemove: () => void;
}) {
  const { data: columns = [] } = useQuery({
    queryKey: ["apis", "columns", join.table],
    queryFn: () => integrationsApi.columns(join.table),
    enabled: Boolean(join.table),
  });

  // Only backward: the base table, plus every table added before this one.
  const sources = [
    { value: "-1", label: `${baseTable} (base table)` },
    ...joins.slice(0, index)
      .map((earlier, i) => ({ value: String(i), label: earlier.table || `table ${i + 1}` }))
      .filter((option) => option.label),
  ];

  const leftColumns = columnsOf(join.from_index);

  const toggle = (name: string) => {
    const has = join.fields.some((f) => f.column === name);
    onChange({
      ...join,
      fields: has
        ? join.fields.filter((f) => f.column !== name)
        : [...join.fields, { column: name, label: null }],
    });
  };

  return (
    <Card className="p-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-xs font-semibold uppercase tracking-wider text-muted">
          Table {index + 2}
        </span>
        <Button variant="dangerSoft" onClick={onRemove}>
          <Trash2 className="h-4 w-4" />
        </Button>
      </div>

      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <Field label="Table">
          <Select
            value={join.table}
            onChange={(table) => onChange({ ...join, table, join_column: "", fields: [] })}
            options={tables.map((t) => ({ value: t.table, label: `${t.group} · ${t.table}` }))}
            placeholder="Pick a table"
            ariaLabel="Join table"
          />
        </Field>
        <Field label="Joined to" hint="Any table already added above this one.">
          <Select
            value={String(join.from_index)}
            onChange={(value) => onChange({
              ...join, from_index: Number(value), base_column: "",
            })}
            options={sources}
            ariaLabel="Join source"
          />
        </Field>
      </div>

      <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
        <Field label="Its column">
          <Select
            value={join.base_column}
            onChange={(base_column) => onChange({ ...join, base_column })}
            options={leftColumns.map((c) => ({ value: c.column, label: c.column }))}
            placeholder="Column"
            ariaLabel="Left column"
          />
        </Field>
        <Field label="Matches this table's">
          <Select
            value={join.join_column}
            onChange={(join_column) => onChange({ ...join, join_column })}
            options={columns.map((c) => ({ value: c.column, label: c.column }))}
            placeholder="Column"
            ariaLabel="Right column"
          />
        </Field>
      </div>

      {join.table && (
        <div className="mt-2">
          <div className="mb-1 flex items-center justify-between">
            <span className="text-xs text-muted">
              Columns to bring across ({join.fields.length})
            </span>
            <Button variant="ghost" onClick={() => onChange({
              ...join,
              fields: columns.map((c) => ({ column: c.column, label: null })),
            })}>
              Select all
            </Button>
          </div>
          <div className="grid max-h-40 grid-cols-2 gap-1 overflow-y-auto rounded-lg border border-line p-2 sm:grid-cols-3">
            {columns.map((c) => (
              <label key={c.column}
                     className="flex min-h-9 cursor-pointer items-center gap-2 text-sm text-body">
                <input type="checkbox" className="h-4 w-4"
                       checked={join.fields.some((f) => f.column === c.column)}
                       onChange={() => toggle(c.column)} />
                <span className="font-mono text-xs">{c.column}</span>
              </label>
            ))}
          </div>
          <p className="mt-1 text-xs text-muted">
            These arrive named{" "}
            <span className="font-mono">{join.table}_column</span>, so they cannot
            collide with a column of the same name on another table.
          </p>
        </div>
      )}
    </Card>
  );
}
