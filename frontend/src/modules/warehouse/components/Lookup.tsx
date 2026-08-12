import { useMemo } from "react";
import { Select } from "@/shared/components";
import { useQuery } from "@tanstack/react-query";
import type { Option } from "../types";

/** One shared empty array, so the default `fallback` does not arrive with a new
 *  identity on every render and invalidate the memos below. */
const NO_FALLBACK: Option[] = [];

/**
 * A master lookup that fetches its own options.
 *
 * Warehouse forms reference eight different masters (items, vendors, POs, bins,
 * projects, employees, vehicles, carriers). Each screen used to load them itself,
 * which meant the GRN form alone fired five list calls on mount and re-fired them on
 * every keystroke. Here one component owns the query, keyed by loader name, so
 * TanStack Query dedupes and caches across every screen that asks for the same list.
 *
 * The search term is deliberately *not* in the query key by default: these lists are
 * small enough to load once and filter in the box. Pass `serverSearch` for the ones
 * that are not — items, mostly — and the term joins the key.
 */

interface Props {
  /** Names the cache entry; two Lookups with the same name share one fetch. */
  name: string;
  load: (search?: string) => Promise<Option[]>;
  value?: number | string | "";
  onChange: (id: number | "", option?: Option) => void;
  placeholder?: string;
  label?: string;
  isDisabled?: boolean;
  isInvalid?: boolean;
  errorMessage?: string;
  /** Refetch as the user types instead of filtering the loaded list. */
  serverSearch?: string;
  /** Rows to show when the loader has not resolved yet — keeps a chosen id visible. */
  fallback?: Option[];
}

export function Lookup({
  name,
  load,
  value,
  onChange,
  placeholder,
  label,
  isDisabled,
  isInvalid,
  errorMessage,
  serverSearch,
  fallback = NO_FALLBACK,
}: Props) {
  // A disabled lookup with nothing chosen has nothing to say, so it stays unfetched.
  // A disabled lookup WITH a value still has to fetch: the Select renders the option
  // whose id matches, and with no options loaded it falls back to the placeholder.
  // That is why every submitted material issue showed "Warehouse", "Indent",
  // "Department" in grey on a document that plainly had all three — the fields were
  // not empty, the list behind them had never loaded.
  const hasValue = value !== "" && value !== null && value !== undefined;
  const { data } = useQuery({
    queryKey: ["wh-lookup", name, serverSearch ?? ""],
    queryFn: () => load(serverSearch || undefined),
    staleTime: 5 * 60_000,
    enabled: !isDisabled || hasValue,
  });

  // Merge, don't choose. A loaded list that simply does not contain the chosen id —
  // an indent that has left the "still to be issued" list because this very document
  // issued it — would otherwise discard the fallback and render the placeholder over
  // a value that exists.
  //
  // Memoised because the identity of this array is what the Autocomplete underneath
  // keys its collection on. Rebuilt every render, it made the host form pay for a
  // fresh collection on every keystroke — survivable for a ten-row master, not for
  // the stocking points: whs_warehouses went from ~20 rows to 993 when the LIP/MDP
  // backfill landed, and the consignment screen (which re-renders on every package
  // and serial edit) spent seconds rebuilding a 993-node collection over and over.
  // The list itself is unchanged — the same rows, in the same order, built once.
  const rows = useMemo(() => {
    const loaded = data ?? [];
    return [
      ...loaded,
      ...fallback.filter((row) => !loaded.some((known) => known.id === row.id)),
    ];
  }, [data, fallback]);
  const options = useMemo(
    () => rows.map((o) => ({
      value: o.id,
      label: o.code ? `${o.code} — ${o.name}` : o.name,
    })),
    [rows],
  );

  return (
    <Select
      value={value ?? ""}
      onChange={(v) => onChange(v === "" ? "" : Number(v), rows.find((o) => String(o.id) === v))}
      options={options}
      label={label}
      placeholder={placeholder}
      isDisabled={isDisabled}
      isInvalid={isInvalid}
      errorMessage={errorMessage}
    />
  );
}
