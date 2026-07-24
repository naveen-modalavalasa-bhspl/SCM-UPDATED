import { api } from "@/shared/api/client";
import type { Schedule, SyncResult, SyncStatus } from "./types";

export const adminApi = {
  // Starts a background sync (survives refresh); poll syncStatus to track it.
  syncNow: () =>
    api.post<{ started: boolean; running: boolean }>("/api/hcm/sync-now").then((r) => r.data),
  syncStatus: () => api.get<SyncStatus>("/api/hcm/sync-status").then((r) => r.data),
  syncEntity: (entity: string) =>
    api.post<{ result: SyncResult }>(`/api/hcm/sync/${entity}`).then((r) => r.data.result),
  syncLog: () => api.get<{ items: SyncResult[] }>("/api/hcm/sync-log").then((r) => r.data.items),
  getSchedule: () => api.get<Schedule>("/api/hcm/schedule").then((r) => r.data),
  setSchedule: (body: { enabled: boolean; interval_minutes: number }) =>
    api.put<Schedule>("/api/hcm/schedule", body).then((r) => r.data),
};
