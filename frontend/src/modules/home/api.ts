import { api } from "@/shared/api/client";
import type { HomeSummary } from "./types";

export const homeApi = {
  summary: () => api.get<HomeSummary>("/api/home/summary").then((r) => r.data),
};
