import { useMutation, useQueryClient, type QueryKey } from "@tanstack/react-query";
import { isAnnouncedGlobally, isErrorClaimed } from "@/shared/api/errors";
import { useToast, type ToastInput } from "./Toast";

/**
 * `useMutation` that tells the user it worked, and says why when it did not.
 *
 * Every write in this app was silent: 38 call sites invalidated a query and left the
 * person guessing whether anything happened. Wrapping the pattern once means a new
 * screen gets feedback by default rather than by remembering.
 *
 * This is for WRITES. A read that fails belongs in the screen's own empty/error
 * state, not in a toast, and a read that succeeds is not news at all.
 *
 * `invalidates` takes the query keys to refetch, so a call site no longer needs its
 * own `useQueryClient` for the common case.
 */
// TArgs defaults to void and comes last, so a `run` that takes no argument infers
// cleanly and the call site stays `mutate()` rather than `mutate(undefined)`.
export function useAction<TResult, TArgs = void>({
  run,
  success,
  invalidates = [],
  onDone,
}: {
  run: (args: TArgs) => Promise<TResult>;
  /**
   * Shown on success — a sentence, or `{ title, message }` when the outcome needs a
   * line of explanation under it. A function when it depends on the result.
   */
  success: ToastInput | ((result: TResult, args: TArgs) => ToastInput);
  invalidates?: QueryKey[];
  onDone?: (result: TResult, args: TArgs) => void;
}) {
  const toast = useToast();
  const qc = useQueryClient();

  return useMutation({
    mutationFn: run,
    onSuccess: (result, args) => {
      invalidates.forEach((queryKey) => qc.invalidateQueries({ queryKey }));
      toast.success(typeof success === "function" ? success(result, args) : success);
      onDone?.(result, args);
    },
    // A backstop, not a replacement for <ErrorBanner>. Screens with somewhere to pin
    // the message should still render `mutation.error` next to the form that failed;
    // this makes sure a failure is never completely silent.
    //
    // Except when it is already on screen. A dropped connection and an expired
    // session are announced once, centrally, by `modules/alerts/apiAlerts.ts` — and
    // the expired one is redirecting the browser as this runs. Toasting them here
    // would be the same news twice.
    onError: (error: Error) => {
      if (isAnnouncedGlobally(error)) return;
      // One tick, so React has committed the error into whatever `<ErrorBanner>` the
      // screen pins it to. A screen showing the reason next to the form that failed
      // does not also need it shouted from the top of the page; a screen with nowhere
      // to pin it still gets the toast, which is what the backstop is for.
      setTimeout(() => {
        if (!isErrorClaimed(error)) toast.fromError(error);
      }, 0);
    },
  });
}
