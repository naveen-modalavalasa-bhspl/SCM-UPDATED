import { useEffect, useState } from "react";
import { Bookmark, Check, Columns3, X } from "lucide-react";
import { Button, Card, Input } from "@/shared/components";
import { deleteView, listViews, saveView, type SavedView } from "../savedViews";
import type { ReportColumn } from "../types";

/** Saved views and the column picker — the two controls that change what you are
 *  looking at rather than which rows come back.
 *
 *  Both write to the URL, so a saved view captures the columns you picked along with
 *  the filters, and sending somebody the link sends them your layout too. */

interface Props {
  ledger: string;
  /** The page's current query string, without "?" — what a save records. */
  query: string;
  onApply: (query: string) => void;
  columns: ReportColumn[];
  /** Keys currently shown. Empty means "the ledger's own default set". */
  visible: string[];
  onColumns: (keys: string[]) => void;
}

export function SavedViews({
  ledger, query, onApply, columns, visible, onColumns,
}: Props) {
  const [views, setViews] = useState<SavedView[]>([]);
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");
  const [picking, setPicking] = useState(false);

  // Views are per ledger, so switching tabs has to reload them.
  useEffect(() => {
    setViews(listViews(ledger));
    setNaming(false);
    setPicking(false);
  }, [ledger]);

  const shown = new Set(visible.length ? visible : columns.map((c) => c.key));

  const commit = () => {
    if (!name.trim()) return;
    setViews(saveView(ledger, name, query));
    setName("");
    setNaming(false);
  };

  const toggle = (key: string) => {
    const next = columns
      .map((c) => c.key)
      .filter((k) => (k === key ? !shown.has(k) : shown.has(k)));
    // Never let the last column go: an empty table is not a view of anything.
    if (next.length === 0) return;
    // All of them selected is the default, and the default is best expressed by
    // saying nothing — it keeps the URL short and survives a ledger gaining a column.
    onColumns(next.length === columns.length ? [] : next);
  };

  return (
    <Card className="mb-3 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="inline-flex items-center gap-1.5 text-sm text-muted">
          <Bookmark className="h-4 w-4" /> Views
        </span>

        {views.length === 0 && !naming && (
          <span className="text-sm text-muted">
            None saved — filter this ledger, then save the view.
          </span>
        )}

        {views.map((view) => (
          <span key={view.name}
                className="inline-flex items-center rounded-full border border-line">
            <button
              type="button"
              onClick={() => onApply(view.query)}
              className="min-h-11 rounded-l-full px-3 text-sm hover:bg-content2"
            >
              {view.name}
            </button>
            <button
              type="button"
              aria-label={`Delete view ${view.name}`}
              onClick={() => setViews(deleteView(ledger, view.name))}
              className="min-h-11 rounded-r-full px-2 text-muted hover:bg-content2"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </span>
        ))}

        <div className="ml-auto flex flex-wrap items-center gap-2">
          {naming ? (
            <>
              <Input
                value={name}
                autoFocus
                aria-label="Name this view"
                placeholder="Name this view…"
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") commit();
                  if (e.key === "Escape") setNaming(false);
                }}
              />
              <Button onClick={commit} disabled={!name.trim()}>
                <Check className="h-4 w-4" /> Save
              </Button>
              <Button variant="subtle" onClick={() => setNaming(false)}>Cancel</Button>
            </>
          ) : (
            <Button variant="subtle" onClick={() => setNaming(true)}>
              <Bookmark className="h-4 w-4" /> Save this view
            </Button>
          )}
          <Button variant="subtle" onClick={() => setPicking((open) => !open)}>
            <Columns3 className="h-4 w-4" />
            Columns ({shown.size}/{columns.length})
          </Button>
        </div>
      </div>

      {picking && (
        <div className="mt-3 border-t border-line pt-3">
          <div className="grid gap-1 sm:grid-cols-3 lg:grid-cols-4">
            {columns.map((col) => (
              <label key={col.key}
                     className="flex min-h-11 items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={shown.has(col.key)}
                  onChange={() => toggle(col.key)}
                />
                {col.label}
              </label>
            ))}
          </div>
          <div className="mt-2 flex gap-2">
            <Button variant="subtle" onClick={() => onColumns([])}>Show all</Button>
          </div>
          <p className="mt-2 text-xs text-muted">
            Exports follow this choice, and the file says on its face how many of the
            ledger's columns it holds.
          </p>
        </div>
      )}
    </Card>
  );
}
