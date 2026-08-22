import { Button } from "@/shared/components";

/**
 * Pick a hundred rows in one press, not five pages of twenty.
 *
 * NEW 2026-08-21. Both consolidation screens page twenty at a time and offered only a
 * per-row tick, so folding a month of requests into one document meant paging through
 * and ticking each line — and a "select all" built from the loaded rows would have been
 * worse than none, because it would tick the visible twenty while saying "all".
 *
 * So the count comes from the SERVER (`/candidates/ids`), and the two presses are kept
 * apart and labelled with their real numbers: "Select all 137" means all 137, "Select
 * these 20" means this page. Nobody has to guess which one they got.
 *
 * Shared by both consolidation screens on purpose. They ask the same question of
 * different documents, and two copies of this would drift.
 */
export function SelectAllBar({
  pickedCount, pageIds, allIds, loadingAll, onPick, noun,
}: {
  /** How many are ticked right now. */
  pickedCount: number;
  /** The ids on the page in view. */
  pageIds: number[];
  /** Every id the current filter matches, from the server. Undefined until loaded. */
  allIds: number[] | undefined;
  loadingAll: boolean;
  onPick: (ids: number[]) => void;
  /** What one row is, for the sentence: "material request" / "requisition". */
  noun: string;
}) {
  const total = allIds?.length ?? 0;
  const pageAllPicked = pageIds.length > 0 && pickedCount >= pageIds.length;
  const everythingPicked = total > 0 && pickedCount === total;

  return (
    <div className="mb-3 flex flex-wrap items-center gap-2 rounded-xl border border-line/70 bg-content1 px-3 py-2">
      <span className="text-sm text-body">
        {pickedCount === 0
          ? `Nothing picked${total ? ` — ${total} ${noun}${total === 1 ? "" : "s"} to choose from` : ""}`
          : (
            <>
              <strong className="text-ink">{pickedCount}</strong> picked
              {total ? ` of ${total}` : ""}
            </>
          )}
      </span>

      <div className="ml-auto flex flex-wrap items-center gap-2">
        {/* Only offered when it would actually do something more than the page button
            beside it — on a single-page list the two are the same press. */}
        {total > pageIds.length && !everythingPicked && (
          <Button
            variant="soft"
            onClick={() => onPick(allIds ?? [])}
            disabled={loadingAll || !allIds}
          >
            {loadingAll ? "Counting…" : `Select all ${total}`}
          </Button>
        )}
        {!pageAllPicked && pageIds.length > 0 && (
          <Button variant="subtle" onClick={() => onPick(pageIds)}>
            Select these {pageIds.length}
          </Button>
        )}
        {pickedCount > 0 && (
          <Button variant="ghost" onClick={() => onPick([])}>Clear</Button>
        )}
      </div>
    </div>
  );
}
