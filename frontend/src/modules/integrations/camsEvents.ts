import { useQuery } from "@tanstack/react-query";
import { camsApi } from "./api";

/**
 * What B-CAMS may send, and which of those moves stock — read off the connection
 * document rather than written here.
 *
 * The panel used to carry its own map of the five event names. That is the same table
 * `docs.WRITES` already is on the server: it registers the endpoints, builds the
 * connection document AND says which two deduct. A copy in the browser is a sixth
 * event away from being wrong, and wrong in the one direction that matters — an event
 * this file has never heard of would have rendered as a raw code with no warning that
 * it changed our stock.
 *
 * Every caller shares one react-query key, so the two panels that need it cost one
 * request between them.
 */
export interface CamsWrite {
  event: string;
  label: string;
  deducts: boolean;
}

export function useCamsWrites() {
  const docs = useQuery({ queryKey: ["cams", "docs"], queryFn: camsApi.docs });

  const writes: CamsWrite[] = (docs.data?.writes ?? []).map((write) => ({
    event: write.event,
    label: write.label,
    deducts: write.deducts_stock,
  }));
  const byEvent = new Map(writes.map((write) => [write.event, write]));

  return {
    writes,
    docs: docs.data,
    loading: docs.isLoading,
    error: docs.error,
    /** The event's name in words. Falls back to the raw code, so an event the document
     *  does not describe is still listed rather than rendering blank. */
    nameOf: (event: string) => byEvent.get(event)?.label ?? event,
    deducts: (event: string) => byEvent.get(event)?.deducts ?? false,
  };
}
