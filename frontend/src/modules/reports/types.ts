/** Reports types. The backend owns the column list, so a row is a bag of values and
 *  the table is built from `ReportColumn[]` — adding a column to a ledger is a
 *  backend-only change. */

export type ColumnKind =
  | "text"
  | "number"
  | "qty"
  | "date"
  | "datetime"
  | "status"
  | "direction";

export interface ReportColumn {
  key: string;
  label: string;
  kind: ColumnKind;
  narrow: boolean;
}

export interface ReportFilter {
  key: string;
  label: string;
  /** "select" gets its options from the data; "text" is a contains-match box. */
  kind: "select" | "text";
  options: string[];
}

export interface ReportLedgerInfo {
  key: string;
  label: string;
  subtitle: string;
  /** The column the from/to date range applies to — named so the UI can say so. */
  date_field: string;
  default_sort: string;
  columns: ReportColumn[];
  filters: ReportFilter[];
}

export type ReportRow = Record<string, string | number | boolean | null>;

export interface ReportRows {
  items: ReportRow[];
  total: number;
  page: number;
  size: number;
  columns: ReportColumn[];
  /** Echo of what the backend actually applied — the audit trail of the query. */
  applied: Record<string, string>;
}

/** Everything that narrows a ledger. Filter values are keyed by filter key, so one
 *  shape serves four ledgers with different filters. */
export interface LedgerQuery {
  search?: string;
  date_from?: string;
  date_to?: string;
  sort?: string;
  dir?: "asc" | "desc";
  page?: number;
  size?: number;
  filters?: Record<string, string>;
  /** Column keys the picker left showing. Empty means the ledger's full set. Sent on
   *  export so the file has the same columns the screen had. */
  cols?: string[];
}
