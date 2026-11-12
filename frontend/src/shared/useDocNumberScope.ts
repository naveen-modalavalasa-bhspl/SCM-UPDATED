import { useEffect, useState } from "react";
import {
  docNumberPayload, docNumberValueCarried, docNumberValueFrom, emptyDocNumberValue,
  type DocNumberLocks, type DocNumberValue,
} from "./documentNumber";

/** The scope columns a document carries — `OrgScopeOut` plus its project. */
export interface ScopedDoc {
  organization_id?: number | null; organization_name?: string | null;
  org_department_id?: number | null; org_department_name?: string | null;
  project_id?: number | null; project_name?: string | null; fiscal_year?: string | null;
}

/**
 * The number card's state for a document that MAY be raised from another (2026-11-12)
 * — a purchase return off a GRN / PO, an indent return off its indent, a transport
 * request off its indent, a vendor payment off its PO. Mirrors the server's
 * `scope.carry_or_select`, so the card shows locked exactly what the save will stamp:
 *
 * - **Editing** a saved document: its own values, every field fixed. An older one,
 *   saved before organisations, shows no card at all (`older`) and sends nothing.
 * - **New, with a source that carries an organisation**: copied from it and locked —
 *   only the year (this document's own) is picked.
 * - **New, with nothing behind it** (or an older source): selected here, opening on
 *   the card's defaults.
 *
 * `carried` must be null while the source is still loading, so the defaults do not
 * run first (the card's `ready` waits on `sourceLoading`).
 */
export function useDocNumberScope({ editing, saved, carried, carriedLabel, sourceLoading = false }: {
  editing: boolean;
  /** The saved document, when editing. Undefined until it has loaded. */
  saved?: ScopedDoc | null;
  /** The source's scope when it carries an organisation, else null. */
  carried?: ScopedDoc | null;
  carriedLabel?: string | null;
  sourceLoading?: boolean;
}) {
  const [value, setValue] = useState<DocNumberValue>(emptyDocNumberValue);
  const [touched, setTouched] = useState(false);
  const carriedKey = carried?.organization_id
    ? `${carried.organization_id}|${carried.project_id ?? ""}|${carried.org_department_id ?? ""}`
    : "";

  // A saved document: its own answer, once it arrives.
  useEffect(() => {
    if (editing && saved) setValue(docNumberValueFrom(saved));
  }, [editing, saved]);

  // A new document: copy from the source when it has an organisation; back to an open
  // card when the source is cleared or changed to one that has none.
  useEffect(() => {
    if (editing) return;
    setValue(carried?.organization_id ? docNumberValueCarried(carried) : emptyDocNumberValue());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing, carriedKey]);

  const older = editing && !!saved && !saved.organization_id;
  const copied = !editing && !!carried?.organization_id;
  const locks: DocNumberLocks = editing
    ? { all: true }
    : copied ? { organisation: true, project: true, department: true } : {};

  return {
    value,
    onChange: (patch: Partial<DocNumberValue>) => setValue((current) => ({ ...current, ...patch })),
    locks,
    /** Hide the card: an older document numbers as it always did. */
    older,
    /** Defaults may fill empty fields — never on an edit, nor while a source loads. */
    ready: !editing && !copied && !sourceLoading,
    source: copied ? { label: carriedLabel || "the document before" } : null,
    touched,
    /** For the save: the selection, and marks the card so a missing field shows. */
    payload: () => {
      setTouched(true);
      return older || editing ? {} : docNumberPayload(value);
    },
  };
}
