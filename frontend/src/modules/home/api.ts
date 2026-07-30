import { api } from "@/shared/api/client";
import type { HomeDateRange, HomeSummary } from "./types";

export const homeApi = {
  summary: (dateRange: HomeDateRange) =>
    api.get<HomeSummary>("/api/home/summary", {
      params: { date_range: dateRange },
    }).then((r) => r.data),
};
