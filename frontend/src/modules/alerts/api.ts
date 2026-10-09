import { api } from "@/shared/api/client";
import type { AlertCatalogResponse } from "./types";

/** All alert copy, as the server has it. */
export async function fetchAlertCatalog(): Promise<AlertCatalogResponse> {
  const { data } = await api.get<AlertCatalogResponse>("/api/alerts/catalog");
  return data;
}
