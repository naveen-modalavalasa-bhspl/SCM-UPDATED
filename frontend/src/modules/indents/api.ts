import { api } from "@/shared/api/client";
import type { Paginated, Option } from "@/shared/types";
import type { Indent, IndentCreate, IndentListRow, IndentStats } from "./types";

export const indentApi = {
  list: (params: { status?: string; page?: number; size?: number }) =>
    api.get<Paginated<IndentListRow>>("/api/indents", { params }).then((r) => r.data),
  stats: () => api.get<IndentStats>("/api/indents/stats").then((r) => r.data),
  get: (id: number) => api.get<Indent>(`/api/indents/${id}`).then((r) => r.data),
  create: (data: IndentCreate) => api.post<Indent>("/api/indents", data).then((r) => r.data),
  submit: (id: number) => api.post<Indent>(`/api/indents/${id}/submit`).then((r) => r.data),
  approve: (id: number, comments: string) =>
    api.post<Indent>(`/api/indents/${id}/approve`, { comments }).then((r) => r.data),
  reject: (id: number, comments: string) =>
    api.post<Indent>(`/api/indents/${id}/reject`, { comments }).then((r) => r.data),
};

export const masterApi = {
  items: (search?: string) =>
    api.get<Paginated<Option>>("/api/items", { params: { search, size: 100 } }).then((r) => r.data.items),
  facilities: () => api.get<{ items: Option[] }>("/api/facilities").then((r) => r.data.items),
};
