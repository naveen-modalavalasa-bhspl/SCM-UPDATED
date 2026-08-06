import { useSyncExternalStore } from "react";
import { getSnapshot, resolveAlert, subscribe } from "../store";
import { AlertDialog } from "./AlertDialog";

/**
 * Renders the alert at the front of the queue, and only that one.
 *
 * Mounted once by `<AlertProvider>`. Anything raised while a dialog is open
 * waits its turn rather than stacking on top.
 */
export function AlertHost() {
  const queue = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const current = queue[0];
  if (!current) return null;
  return (
    <AlertDialog
      // Keyed by id so the countdown bar and focus restart for each dialog
      // instead of inheriting the previous one's half-drained state.
      key={current.id}
      alert={current}
      onResolve={(confirmed) => resolveAlert(current.id, confirmed)}
    />
  );
}
