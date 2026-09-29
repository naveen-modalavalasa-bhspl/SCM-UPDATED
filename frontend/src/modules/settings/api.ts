import { api } from "@/shared/api/client";
import type {
  AppSettings, CodeFormats, CodeFormatToken,
  MonthlyIndentCycle, MonthlyIndentRule, MonthlyIndentSettings, MonthlyIndentSubmissionRule,
} from "./types";

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

export const monthlyIndentApi = {
  get: () =>
    api.get<MonthlyIndentSettings>("/api/monthly-indent/settings").then((r) => r.data),
  updateCycle: (body: MonthlyIndentCycle) =>
    api.put<MonthlyIndentSettings>("/api/monthly-indent/cycle", body).then((r) => r.data),
  createRule: (body: Partial<MonthlyIndentRule>) =>
    api.post<MonthlyIndentRule>("/api/monthly-indent/rules", body).then((r) => r.data),
  updateRule: (id: number, body: Partial<MonthlyIndentRule>) =>
    api.put<MonthlyIndentRule>(`/api/monthly-indent/rules/${id}`, body).then((r) => r.data),
  deleteRule: (id: number) =>
    api.delete(`/api/monthly-indent/rules/${id}`).then((r) => r.data),
  createSubmissionRule: (body: Partial<MonthlyIndentSubmissionRule>) =>
    api.post<MonthlyIndentSubmissionRule>("/api/monthly-indent/submission-rules", body)
      .then((r) => r.data),
  updateSubmissionRule: (id: number, body: Partial<MonthlyIndentSubmissionRule>) =>
    api.put<MonthlyIndentSubmissionRule>(`/api/monthly-indent/submission-rules/${id}`, body)
      .then((r) => r.data),
  deleteSubmissionRule: (id: number) =>
    api.delete(`/api/monthly-indent/submission-rules/${id}`).then((r) => r.data),
  preview: (template: string) =>
    api.post<{ message: string }>("/api/monthly-indent/preview", { template })
      .then((r) => r.data.message),
  runNow: () =>
    api.post<{ checked: number; sent: number; skipped: number }>("/api/monthly-indent/run")
      .then((r) => r.data),
};
