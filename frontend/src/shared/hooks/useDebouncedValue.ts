import { useEffect, useState } from "react";

/**
 * A barcode scanner types a whole code in tens of ms and lands Enter — but a
 * per-keystroke `search` state fires one server query per character, so a long
 * code queues dozens of requests that race each other and can resolve after the
 * scanner has moved on. Debouncing the value sent to the query fixes that
 * without changing how the input itself behaves.
 */
export function useDebouncedValue<T>(value: T, delayMs = 300): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);

  return debounced;
}
