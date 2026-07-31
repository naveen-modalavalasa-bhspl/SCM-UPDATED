import { useMutation, useQueryClient, type QueryKey } from "@tanstack/react-query";
import { useToast } from "./Toast";

/**
 * `useMutation` that tells the user it worked.
 *
 * Every write in this app was silent: 38 call sites invalidated a query and left the
 * person guessing whether anything happened. Wrapping the pattern once means a new
 * screen gets feedback by default rather than by remembering.
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
  /** Shown on success. A function when the message depends on the result. */
  success: string | ((result: TResult, args: TArgs) => string);
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
    onError: (error: Error) => toast.error(error.message),
  });
}
