import { api } from "@/shared/api/client";
import type { InventoryOverview } from "./types";

export const inventoryApi = {
  overview: () =>
    api.get<InventoryOverview>("/api/inventory").then((response) => response.data),
};
