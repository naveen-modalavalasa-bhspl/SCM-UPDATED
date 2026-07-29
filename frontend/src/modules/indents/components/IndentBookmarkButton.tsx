import { useState, type MouseEvent } from "react";
import { useMutation, useQueryClient, type Query } from "@tanstack/react-query";
import { Pin } from "lucide-react";
import type { Paginated } from "@/shared/types";
import {
  INDENT_QUERY_ROOT, indentApi, type IndentAccountScope,
} from "../api";
import type { IndentListRow } from "../types";

type ErrorHandler = (message: string) => void;

function isListQuery(query: Query) {
  return query.queryKey[0] === INDENT_QUERY_ROOT && query.queryKey[3] === "list";
}

function isBoardQuery(query: Query) {
  return query.queryKey[0] === INDENT_QUERY_ROOT && query.queryKey[3] === "board";
}

function isBoardStatsQuery(query: Query) {
  return (
    query.queryKey[0] === INDENT_QUERY_ROOT
    && query.queryKey[3] === "stats"
    && Array.isArray(query.queryKey[4])
    && query.queryKey[4][0] === "board"
  );
}

export function isIndentListOrBoardQuery(query: Query) {
  return isListQuery(query) || isBoardQuery(query) || isBoardStatsQuery(query);
}

function updateRows(
  data: Paginated<IndentListRow> | undefined,
  row: IndentListRow,
  value: "YES" | "NO",
  board: boolean,
) {
  if (!data) return data;
  const exists = data.items.some((item) => item.id === row.id);
  if (board && value === "NO") {
    return {
      ...data,
      items: data.items.filter((item) => item.id !== row.id),
      total: exists ? Math.max(0, data.total - 1) : data.total,
    };
  }
  if (exists) {
    return {
      ...data,
      items: data.items.map((item) =>
        item.id === row.id ? { ...item, is_bookmarked: value } : item
      ),
    };
  }
  if (board && value === "YES") {
    return {
      ...data,
      items: [{ ...row, is_bookmarked: "YES" }, ...data.items],
      total: data.total + 1,
    };
  }
  return data;
}

export function IndentBookmarkButton({
  row,
  accountScope,
  onError,
}: {
  row: IndentListRow;
  accountScope: IndentAccountScope;
  onError?: ErrorHandler;
}) {
  const qc = useQueryClient();
  const [saving, setSaving] = useState(false);
  const bookmarked = row.is_bookmarked === "YES";
  const nextValue = bookmarked ? "NO" : "YES";
  const label = bookmarked ? "Remove from Board" : "Add to Board";

  const mutation = useMutation({
    mutationFn: () => bookmarked ? indentApi.unbookmark(row.id) : indentApi.bookmark(row.id),
    onMutate: async () => {
      setSaving(true);
      onError?.("");
      const touched = qc.getQueriesData<Paginated<IndentListRow>>({
        predicate: (query) => (
          query.queryKey[0] === INDENT_QUERY_ROOT
          && query.queryKey[1] === accountScope.employeeId
          && query.queryKey[2] === accountScope.activePositionId
          && (isListQuery(query) || isBoardQuery(query))
        ),
      });
      touched.forEach(([key, data]) => {
        const board = key[3] === "board";
        qc.setQueryData(key, updateRows(data, row, nextValue, board));
      });
      return { touched };
    },
    onError: (_error, _vars, context) => {
      context?.touched.forEach(([key, data]) => qc.setQueryData(key, data));
      onError?.("Could not update board bookmark. Please try again.");
    },
    onSettled: () => {
      setSaving(false);
      qc.invalidateQueries({
        predicate: (query) => (
          query.queryKey[0] === INDENT_QUERY_ROOT
          && query.queryKey[1] === accountScope.employeeId
          && query.queryKey[2] === accountScope.activePositionId
          && isIndentListOrBoardQuery(query)
        ),
      });
    },
  });

  const onClick = (event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    if (!saving && !mutation.isPending) mutation.mutate();
  };

  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={bookmarked}
      title={label}
      disabled={saving || mutation.isPending}
      onClick={onClick}
      className={`grid h-9 w-9 shrink-0 place-items-center rounded-full border transition-colors disabled:opacity-50 ${
        bookmarked
          ? "border-brand bg-brand/10 text-brand"
          : "border-line bg-content1 text-muted hover:border-brand hover:text-brand"
      }`}
    >
      <Pin className="h-4 w-4" fill={bookmarked ? "currentColor" : "none"} />
    </button>
  );
}
