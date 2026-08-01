import { Select } from "./compat";
import { useQuery } from "@tanstack/react-query";
import type { Option } from "../types";

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
  fallback = [],
}: Props) {
  const { data } = useQuery({
    queryKey: ["wh-lookup", name, serverSearch ?? ""],
    queryFn: () => load(serverSearch || undefined),
    staleTime: 5 * 60_000,
    enabled: !isDisabled,
  });

  const rows = data?.length ? data : fallback;
  const options = rows.map((o) => ({
    value: o.id,
    label: o.code ? `${o.code} — ${o.name}` : o.name,
  }));

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
