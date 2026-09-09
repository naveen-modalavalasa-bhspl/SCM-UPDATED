import { api } from "@/shared/api/client";
import type { HomeCustomRange, HomeDateRange, HomeSummary } from "./types";

export interface HomeAccountScope {
  employeeId: number | null;
  activePositionId: number | null;
}

export const HOME_QUERY_ROOT = "home-summary";

export const homeKeys = {
  summary: (scope: HomeAccountScope, dateRange: HomeDateRange,
            custom?: HomeCustomRange) =>
    // The dates are part of the key, or switching between two custom windows would
    // serve the first one's cached answer for the second.
    [HOME_QUERY_ROOT, scope.employeeId, scope.activePositionId, dateRange,
     custom?.from ?? "", custom?.to ?? ""] as const,
};

export const homeApi = {
  summary: (dateRange: HomeDateRange, custom?: HomeCustomRange) =>
    api.get<HomeSummary>("/api/home/summary", {
      params: {
        date_range: dateRange,
        // Only sent for a custom window; the server ignores them otherwise, but
        // leaving them off keeps every other range's URL (and its cache key) clean.
        ...(dateRange === "custom" && custom?.from ? { date_from: custom.from } : {}),
        ...(dateRange === "custom" && custom?.to ? { date_to: custom.to } : {}),
      },
    }).then((r) => r.data),
};
