import { useEffect, useMemo, useState } from "react";
import { Autocomplete, AutocompleteItem } from "@heroui/react";
import { useQuery } from "@tanstack/react-query";
import { Layers, PackageSearch } from "lucide-react";
import { itemOptions } from "../api";
import { fmtQty, num } from "../format";
import type { ItemOption } from "../types";

/**
 * Which item is leaving the store, on an issue nobody raised an indent for.
 *
 * It used to be the plain catalogue lookup — several thousand rows of item master,
 * of which a given stocking point holds a couple of dozen. So a storekeeper picked an
 * item, the batch picker under it said "nothing on the shelf", the location picker
 * said "pick the batch first", and nothing anywhere said the real thing: **this point
 * has never held that item.** The dead end was three decisions deep and the reason was
 * invisible at every one of them.
 *
 * So the list is what the point can actually give, each row carrying the quantity and
 * how far it is spread — read off `stk_balance` by the same `drawable` rule the batch
 * and location pickers use one level down, so the three can never disagree about
 * whether there is anything to take.
 *
 * **The whole catalogue is still one press away.** A storekeeper occasionally has to
 * name an item the system does not think is there — a correction, goods found on the
 * floor, a return being recorded — and a picker that simply refuses to show it is a
 * screen he has to work around. What it must not do is offer that as the default and
 * say nothing: an item with nothing here is drawn as such, and the row it lands on
 * says so in a sentence.
 */

interface Props {
  value: number | "";
  onChange: (id: number | "", option?: ItemOption) => void;
  /** The point the goods are leaving. Nothing can be said about stock without it. */
  warehouseId: number;
  /** An indent-linked document may draw on its own reservation, so its stock counts
   *  as available to it — the same reason every other source list takes this. */
  indentId?: number | null;
  /** Lots held for this project count as on hand. */
  projectId?: number | null;
  isDisabled?: boolean;
  /** Keeps a chosen item visible before the list resolves, or when it has dropped
   *  out of it — a saved line whose item the point no longer stocks. */
  fallback?: ItemOption | null;
}

export function ItemPicker({
  value, onChange, warehouseId, indentId, projectId, isDisabled, fallback,
}: Props) {
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [onlyHere, setOnlyHere] = useState(true);

  const { data = [], isFetching } = useQuery({
    queryKey: ["wh-issue-items", warehouseId, indentId ?? 0, projectId ?? 0, search, onlyHere],
    queryFn: () => itemOptions(search || undefined, warehouseId, onlyHere, indentId, projectId),
    enabled: !!warehouseId,
    staleTime: 60_000,
    placeholderData: (previous) => previous,
  });

  const rows = useMemo(() => {
    const loaded = data ?? [];
    return fallback && !loaded.some((row) => row.id === fallback.id)
      ? [...loaded, fallback]
      : loaded;
  }, [data, fallback]);

  const chosen = rows.find((row) => row.id === value);
  const chosenLabel = chosen ? `${chosen.code ?? ""} — ${chosen.name}` : "";
  const empty = !isFetching && rows.length === 0;

  // Typing eight characters of an item code must not be eight round trips against a
  // master this size. Same 400 ms the rest of this screen settles on.
  //
  // Picking a row makes the box echo that row's own label back through
  // `onInputChange`, and that is the selection being displayed, not a search for it —
  // treated as one it would re-fetch the list on every pick to find the single item
  // already chosen.
  useEffect(() => {
    const timer = setTimeout(
      () => setSearch(query.trim() === chosenLabel.trim() ? "" : query.trim()),
      400,
    );
    return () => clearTimeout(timer);
  }, [query, chosenLabel]);

  return (
    <div>
      {/* Which list this is, and the way to the other one. Placed above the box
        * so the open dropdown overlay cannot obscure the toggle button. */}
      <div className="mb-1 flex flex-wrap items-center justify-between gap-x-2 gap-y-0.5 text-[11px] leading-tight">
        <span className="inline-flex items-center gap-1 text-muted">
          {onlyHere ? <Layers className="h-3 w-3" /> : <PackageSearch className="h-3 w-3" />}
          {onlyHere
            ? `On the shelf here${rows.length ? ` · ${rows.length}` : ""}`
            : "Every item in the catalogue"}
        </span>
        <button
          type="button"
          onClick={() => setOnlyHere((only) => !only)}
          disabled={isDisabled || !warehouseId}
          className="rounded font-semibold text-brand underline-offset-2 hover:underline disabled:text-muted cursor-pointer"
        >
          {onlyHere ? "Show every item" : "Only what is here"}
        </button>
      </div>

      <Autocomplete
        aria-label="Item"
        variant="bordered"
        radius="md"
        isDisabled={isDisabled || !warehouseId}
        placeholder={
          !warehouseId ? "Pick the warehouse first"
            : onlyHere ? "Search what is on the shelf here" : "Search every item"
        }
        // `items`, not `defaultItems`: the narrowing happens on the server, so the
        // box must show what came back rather than filter it a second time by hand.
        items={rows}
        selectedKey={value === "" ? null : String(value)}
        onInputChange={setQuery}
        onSelectionChange={(key) => {
          if (key == null) {
            onChange("");
            return;
          }
          onChange(Number(key),
                   rows.find((row) => String(row.id) === String(key)));
        }}
        inputProps={{
          classNames: { inputWrapper: "min-h-11 border-line bg-content1" },
        }}
        listboxProps={{
          emptyContent: isFetching ? (
            <div className="py-4 text-center text-xs text-muted">Looking…</div>
          ) : onlyHere ? (
            <div className="flex flex-col items-center gap-2 px-3 py-4 text-center">
              <span className="text-xs text-muted">Nothing matching is on the shelf here.</span>
              <button
                type="button"
                onPointerDown={(e) => {
                  e.preventDefault();
                  setOnlyHere(false);
                }}
                onClick={() => setOnlyHere(false)}
                className="inline-flex items-center gap-1.5 rounded-lg bg-brand px-3 py-1.5 text-xs font-semibold text-white shadow-sm hover:bg-brand/90 active:scale-95 transition cursor-pointer"
              >
                <PackageSearch className="h-3.5 w-3.5" />
                Show every item in catalogue
              </button>
            </div>
          ) : (
            <div className="py-4 text-center text-xs text-muted">No item matches that.</div>
          ),
        }}
      >
        {(row: ItemOption) => (
          <AutocompleteItem
            key={String(row.id)}
            textValue={`${row.code ?? ""} ${row.name}`}
          >
            <div className="flex items-start justify-between gap-3 py-0.5">
              <div className="min-w-0">
                <div className="truncate font-mono text-xs font-semibold text-ink">
                  {row.code ?? row.name}
                </div>
                <div className="truncate text-[11px] leading-tight text-muted">
                  {row.name}
                  {row.uom_code ? ` · ${row.uom_code}` : ""}
                </div>
              </div>
              <StockNote option={row} />
            </div>
          </AutocompleteItem>
        )}
      </Autocomplete>

      {empty && onlyHere && (
        <div className="mt-1 text-[11px] text-warn">
          Nothing matching is stocked at this point.
        </div>
      )}
    </div>
  );
}

/** What the point holds of this item, on the option itself. `undefined` is "no point
 *  was named" and says nothing; zero is an answer and says so. */
function StockNote({ option }: { option: ItemOption }) {
  if (option.on_hand === undefined || option.on_hand === null) return null;
  const qty = num(option.on_hand);
  if (qty <= 0) {
    return (
      <span className="shrink-0 rounded bg-warn-bg px-1.5 py-0.5 text-[10px] font-semibold text-warn">
        None here
      </span>
    );
  }
  return (
    <div className="shrink-0 text-right">
      <div className="tabular text-xs font-semibold text-ink">{fmtQty(qty)}</div>
      <div className="text-[10px] leading-tight text-muted">
        {option.batch_count ? `${option.batch_count} batch${option.batch_count === 1 ? "" : "es"}` : "on hand"}
        {option.location_count
          ? ` · ${option.location_count} location${option.location_count === 1 ? "" : "s"}`
          : ""}
      </div>
    </div>
  );
}
