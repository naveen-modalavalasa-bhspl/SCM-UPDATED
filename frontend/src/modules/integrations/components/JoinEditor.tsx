import { useQuery } from "@tanstack/react-query";
import { Trash2 } from "lucide-react";
import { Button, Card, Field, Select } from "@/shared/components";
import { integrationsApi } from "../api";
import { ColumnPicker } from "./ColumnPicker";
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
  const leftTable = join.from_index < 0
    ? baseTable
    : joins[join.from_index]?.table || `table ${join.from_index + 2}`;

  const toggle = (name: string) => {
    const has = join.fields.some((f) => f.column === name);
    onChange({
      ...join,
      fields: has
        ? join.fields.filter((f) => f.column !== name)
        : [...join.fields, { column: name, label: null }],
    });
  };

  const add = (names: string[]) => {
    const held = new Set(join.fields.map((f) => f.column));
    onChange({
      ...join,
      fields: [
        ...join.fields,
        ...names.filter((name) => !held.has(name)).map((name) => ({ column: name, label: null })),
      ],
    });
  };

  return (
    <Card className="p-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-xs font-semibold uppercase tracking-wider text-muted">
          Table {index + 2}
          {join.table && <span className="ml-1 font-mono normal-case">· {join.table}</span>}
        </span>
        <Button variant="dangerSoft" onClick={onRemove}>
          <Trash2 className="h-4 w-4" /> Remove
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
        {/* The two labels name the tables rather than saying "its" and "this one" —
            with three tables chained, "its column" is genuinely ambiguous. */}
        <Field label={`Column on ${leftTable}`}>
          <Select
            value={join.base_column}
            onChange={(base_column) => onChange({ ...join, base_column })}
            options={leftColumns.map((c) => ({ value: c.column, label: c.column }))}
            placeholder="Column"
            ariaLabel="Left column"
          />
        </Field>
        <Field label={`Matches column on ${join.table || "this table"}`}>
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
        <div className="mt-3">
          <ColumnPicker
            dense
            label="Columns to bring across"
            columns={columns}
            selected={join.fields.map((f) => f.column)}
            onToggle={toggle}
            onAdd={add}
            onClear={() => onChange({ ...join, fields: [] })}
            hint={`These arrive named ${join.table}_column, so they cannot collide with a column of the same name on another table.`}
          />
        </div>
      )}
    </Card>
  );
}
