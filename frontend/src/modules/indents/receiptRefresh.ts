import type { QueryClient } from "@tanstack/react-query";
import { indentKeys, type IndentAccountScope } from "./api";
import type { Indent } from "./types";

export async function cancelIndentReceiptReads(
  queryClient: QueryClient,
  scope: IndentAccountScope,
  indentId: number,
) {
  await Promise.all([
    queryClient.cancelQueries({ queryKey: indentKeys.detail(scope, indentId), exact: true }),
    queryClient.cancelQueries({ queryKey: indentKeys.journey(scope, indentId), exact: true }),
  ]);
}

export async function commitConfirmedIndentReceipt(
  queryClient: QueryClient,
  scope: IndentAccountScope,
  updated: Indent,
) {
  await cancelIndentReceiptReads(queryClient, scope, updated.id);
  queryClient.setQueryData(indentKeys.detail(scope, updated.id), updated);
  void queryClient.invalidateQueries({
    queryKey: indentKeys.journey(scope, updated.id),
    refetchType: "all",
  }).catch(() => undefined);
}
