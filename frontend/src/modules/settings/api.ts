import { api } from "@/shared/api/client";
import type { AppSettings } from "./types";

export const settingsApi = {
  get: () => api.get<AppSettings>("/api/settings").then((r) => r.data),
  update: (body: AppSettings) => api.put<AppSettings>("/api/settings", body).then((r) => r.data),
};
