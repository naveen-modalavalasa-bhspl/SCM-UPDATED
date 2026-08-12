import { api } from "@/shared/api/client";
import type { AppSettings, CodeFormats, CodeFormatToken } from "./types";

export const settingsApi = {
  get: () => api.get<AppSettings>("/api/settings").then((r) => r.data),
  update: (body: AppSettings) => api.put<AppSettings>("/api/settings", body).then((r) => r.data),
};

/** The asset / consumable code formula. Its own endpoints and its own permission —
 *  it decides what every unit received from now on is labelled with. */
export const codeFormatsApi = {
  get: () => api.get<CodeFormats>("/api/settings/code-formats").then((r) => r.data),
  update: (body: CodeFormats) =>
    api.put<CodeFormats>("/api/settings/code-formats", body).then((r) => r.data),
  tokens: () =>
    api.get<{ tokens: CodeFormatToken[] }>("/api/settings/code-formats/tokens")
      .then((r) => r.data),
  // Rendered by the backend on purpose: the screen must not implement a second
  // renderer that could disagree with the one the putaway uses.
  preview: (template: string, isAsset: boolean) =>
    api.get<{ preview: string }>("/api/settings/code-formats/preview", {
      params: { template, is_asset: isAsset },
    }).then((r) => r.data),
};
