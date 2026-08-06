import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { indentKeys } from "../api";
import { cancelIndentReceiptReads, commitConfirmedIndentReceipt } from "../receiptRefresh";
import type { Indent } from "../types";

const scope = { employeeId: 7, activePositionId: 11 };

function indent(status = "PARTIALLY_FULFILLED"): Indent {
  return {
    id: 42,
    indent_no: "IND/42",
    status,
    priority: "NORMAL",
    total_items: 1,
    total_qty: 6,
    is_bookmarked: "NO",
    can_submit: false,
    can_approve: false,
    can_reject: false,
    created_at: "2026-08-02T09:00:00Z",
    items: [],
  };
}

describe("confirmed receipt Journey refresh", () => {
  it("stores authoritative receipt state and actively refetches the versioned Journey", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidate = vi.spyOn(client, "invalidateQueries").mockResolvedValue(undefined);

    await commitConfirmedIndentReceipt(client, scope, indent("CLOSED"));

    expect(client.getQueryData<Indent>(indentKeys.detail(scope, 42))?.status).toBe("CLOSED");
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: indentKeys.journey(scope, 42),
      refetchType: "all",
    });
  });

  it("cancels an older Journey response before receipt state is committed", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    let resolveStale!: (value: string) => void;
    const stale = new Promise<string>((resolve) => { resolveStale = resolve; });
    const request = client.fetchQuery({
      queryKey: indentKeys.journey(scope, 42),
      queryFn: () => stale,
    });

    await cancelIndentReceiptReads(client, scope, 42);
    client.setQueryData(indentKeys.journey(scope, 42), "fresh receipt journey");
    resolveStale("stale journey");
    await expect(request).rejects.toBeDefined();

    expect(client.getQueryData(indentKeys.journey(scope, 42))).toBe("fresh receipt journey");
  });
});
