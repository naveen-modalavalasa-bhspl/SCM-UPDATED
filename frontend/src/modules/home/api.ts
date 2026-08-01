import { api } from "@/shared/api/client";
import type { HomeDateRange, HomeSummary } from "./types";

export interface HomeAccountScope {
  employeeId: number | null;
  activePositionId: number | null;
}

export const HOME_QUERY_ROOT = "home-summary";

export const homeKeys = {
  summary: (scope: HomeAccountScope, dateRange: HomeDateRange) =>
    [HOME_QUERY_ROOT, scope.employeeId, scope.activePositionId, dateRange] as const,
};

export const homeApi = {
  summary: (dateRange: HomeDateRange) =>
    api.get<HomeSummary>("/api/home/summary", {
      params: { date_range: dateRange },
    }).then((r) => r.data),
};
