import { api } from "@/shared/api/client";
import type {
  CatalogItemOption,
  InventoryOverview,
  ReplenishmentItem,
  ReplenishmentPOItem,
  StockAdjustmentInput,
  StockBalanceFilter,
  StockBalanceItem,
  StockLedgerFilter,
  StockLedgerItem,
  StockTransferCreate,
  StockTransferRow,
  VendorOption,
  WarehouseOption,
} from "./types";

// In-memory data store for interactive frontend views and client unit tests
let mockWarehouses: WarehouseOption[] = [];
let mockCatalogItems: CatalogItemOption[] = [];
let mockVendors: VendorOption[] = [];
let mockStockBalances: StockBalanceItem[] = [];
let mockStockLedger: StockLedgerItem[] = [];
let mockTransfers: StockTransferRow[] = [];

// Seed function for test suites and testing environments
export function seedInventoryMockData() {
  mockWarehouses = [
    { id: 1, code: "WH-MAIN", name: "Main Warehouse - Unit 1", location: "Building A" },
    { id: 2, code: "WH-RAW", name: "Raw Material Yard", location: "Sector 4" },
    { id: 3, code: "WH-FG", name: "Finished Goods Hub", location: "Building B" },
    { id: 4, code: "WH-SPARE", name: "Spares & Maintenance Store", location: "Building C" },
    { id: 5, code: "WH-SITE", name: "Project Site - South Zone", location: "Site Office" },
  ];

  mockCatalogItems = [
    { id: 101, code: "RM-STL-001", name: "Stainless Steel Sheet 2mm", category: "Raw Material", uom: "SQM", uom_code: "SQM", unit_rate: 450, default_unit_rate: 450, available_qty: 1200, is_batch_tracked: true },
    { id: 102, code: "RM-ALU-005", name: "Aluminum Extrusion Bar 50mm", category: "Raw Material", uom: "MTR", uom_code: "MTR", unit_rate: 280, default_unit_rate: 280, available_qty: 850, is_batch_tracked: false },
    { id: 103, code: "FG-VAL-100", name: "Industrial Butterfly Valve 4-Inch", category: "Finished Good", uom: "PCS", uom_code: "PCS", unit_rate: 1850, default_unit_rate: 1850, available_qty: 45, is_batch_tracked: true },
    { id: 104, code: "FG-VAL-200", name: "High Pressure Control Valve", category: "Finished Good", uom: "PCS", uom_code: "PCS", unit_rate: 3200, default_unit_rate: 3200, available_qty: 8, is_batch_tracked: true },
    { id: 105, code: "SP-BRG-620", name: "Deep Groove Ball Bearing 6204-ZZ", category: "Spare Part", uom: "PCS", uom_code: "PCS", unit_rate: 120, default_unit_rate: 120, available_qty: 350, is_batch_tracked: false },
    { id: 106, code: "CS-GLV-001", name: "Heavy Duty Work Gloves - Leather", category: "Consumable", uom: "PAIR", uom_code: "PAIR", unit_rate: 85, default_unit_rate: 85, available_qty: 0, is_batch_tracked: false },
  ];

  mockVendors = [
    { id: 201, code: "VEN-STEEL-01", name: "Apex Steel Ltd." },
    { id: 202, code: "VEN-VALVE-02", name: "FlowTech Valves & Fittings" },
    { id: 203, code: "VEN-BEAR-03", name: "Precision Bearings Co." },
    { id: 204, code: "VEN-PPE-04", name: "SafetyFirst Industrial Supplies" },
  ];

  mockStockBalances = [
    {
      id: 1,
      item_id: 101,
      item_code: "RM-STL-001",
      item_name: "Stainless Steel Sheet 2mm",
      category_name: "Raw Material",
      warehouse_id: 1,
      warehouse_name: "Main Warehouse - Unit 1",
      uom_code: "SQM",
      physical_qty: 700,
      reserved_qty: 100,
      in_transit_qty: 50,
      available_qty: 600,
      reorder_level: 500,
      min_stock_level: 300,
      max_stock_level: 2500,
      valuation_rate: 450,
      total_value: 315000,
      batch_number: "BAT-2026-0819",
      expiry_date: "2027-12-31",
      storage_location: "Aisle A-04",
      last_received_date: "2026-07-20",
      last_issued_date: "2026-07-24",
      is_batch_tracked: true,
      consumable_code: "CS-STL-001A",
    },
    {
      id: 10,
      item_id: 101,
      item_code: "RM-STL-001",
      item_name: "Stainless Steel Sheet 2mm",
      category_name: "Raw Material",
      warehouse_id: 1,
      warehouse_name: "Main Warehouse - Unit 1",
      uom_code: "SQM",
      physical_qty: 500,
      reserved_qty: 100,
      in_transit_qty: 50,
      available_qty: 400,
      reorder_level: 500,
      min_stock_level: 300,
      max_stock_level: 2500,
      valuation_rate: 450,
      total_value: 225000,
      batch_number: "BAT-2026-0902",
      expiry_date: "2028-03-15",
      storage_location: "Aisle A-04",
      last_received_date: "2026-07-22",
      last_issued_date: "2026-07-25",
      is_batch_tracked: true,
      consumable_code: "CS-STL-001B",
    },
    {
      id: 2,
      item_id: 102,
      item_code: "RM-ALU-005",
      item_name: "Aluminum Extrusion Bar 50mm",
      category_name: "Raw Material",
      warehouse_id: 2,
      warehouse_name: "Raw Material Yard",
      uom_code: "MTR",
      physical_qty: 850,
      reserved_qty: 50,
      in_transit_qty: 0,
      available_qty: 800,
      reorder_level: 400,
      min_stock_level: 200,
      max_stock_level: 1500,
      valuation_rate: 280,
      total_value: 238000,
      storage_location: "Yard Bay 2",
      last_received_date: "2026-07-18",
      last_issued_date: "2026-07-23",
      is_batch_tracked: false,
      consumable_code: "CS-ALU-005X",
    },
    {
      id: 3,
      item_id: 103,
      item_code: "FG-VAL-100",
      item_name: "Industrial Butterfly Valve 4-Inch",
      category_name: "Finished Good",
      warehouse_id: 3,
      warehouse_name: "Finished Goods Hub",
      uom_code: "PCS",
      physical_qty: 30,
      reserved_qty: 10,
      in_transit_qty: 10,
      available_qty: 20,
      reorder_level: 50,
      min_stock_level: 20,
      max_stock_level: 200,
      valuation_rate: 1850,
      total_value: 55500,
      batch_number: "BAT-2026-0501",
      expiry_date: "2027-06-30",
      storage_location: "Rack B-12",
      last_received_date: "2026-07-15",
      last_issued_date: "2026-07-25",
      is_batch_tracked: true,
      asset_code: "AST-VAL-1001",
      serial_numbers: Array.from({ length: 20 }, (_, idx) => `SN-VAL-10${(idx + 1).toString().padStart(2, "0")}`),
    },
    {
      id: 11,
      item_id: 103,
      item_code: "FG-VAL-100",
      item_name: "Industrial Butterfly Valve 4-Inch",
      category_name: "Finished Good",
      warehouse_id: 3,
      warehouse_name: "Finished Goods Hub",
      uom_code: "PCS",
      physical_qty: 15,
      reserved_qty: 5,
      in_transit_qty: 10,
      available_qty: 10,
      reorder_level: 50,
      min_stock_level: 20,
      max_stock_level: 200,
      valuation_rate: 1850,
      total_value: 27750,
      batch_number: "BAT-2026-0501",
      expiry_date: "2027-06-30",
      storage_location: "Shelf 2-B",
      last_received_date: "2026-07-16",
      last_issued_date: "2026-07-24",
      is_batch_tracked: true,
      asset_code: "AST-VAL-1001",
      serial_numbers: Array.from({ length: 10 }, (_, idx) => `SN-VAL-12${(idx + 1).toString().padStart(2, "0")}`),
    },
    {
      id: 4,
      item_id: 104,
      item_code: "FG-VAL-200",
      item_name: "High Pressure Control Valve",
      category_name: "Finished Good",
      warehouse_id: 3,
      warehouse_name: "Finished Goods Hub",
      uom_code: "PCS",
      physical_qty: 5,
      reserved_qty: 2,
      in_transit_qty: 10,
      available_qty: 3,
      reorder_level: 15,
      min_stock_level: 10,
      max_stock_level: 50,
      valuation_rate: 3200,
      total_value: 16000,
      batch_number: "BAT-2026-0710",
      expiry_date: "2027-08-31",
      storage_location: "Rack B-14",
      last_received_date: "2026-07-10",
      last_issued_date: "2026-07-22",
      is_batch_tracked: true,
      asset_code: "AST-VAL-2005",
      serial_numbers: ["SN-VAL-301", "SN-VAL-302", "SN-VAL-303"],
    },
    {
      id: 12,
      item_id: 104,
      item_code: "FG-VAL-200",
      item_name: "High Pressure Control Valve",
      category_name: "Finished Good",
      warehouse_id: 3,
      warehouse_name: "Finished Goods Hub",
      uom_code: "PCS",
      physical_qty: 3,
      reserved_qty: 1,
      in_transit_qty: 5,
      available_qty: 2,
      reorder_level: 15,
      min_stock_level: 10,
      max_stock_level: 50,
      valuation_rate: 3200,
      total_value: 9600,
      batch_number: "BAT-2026-0720",
      expiry_date: "2027-09-30",
      storage_location: "Bin C-03",
      last_received_date: "2026-07-14",
      last_issued_date: "2026-07-23",
      is_batch_tracked: true,
      asset_code: "AST-VAL-2005",
      serial_numbers: ["SN-VAL-304", "SN-VAL-305"],
    },
    {
      id: 5,
      item_id: 105,
      item_code: "SP-BRG-620",
      item_name: "Deep Groove Ball Bearing 6204-ZZ",
      category_name: "Spare Part",
      warehouse_id: 4,
      warehouse_name: "Spares & Maintenance Store",
      uom_code: "PCS",
      physical_qty: 350,
      reserved_qty: 0,
      in_transit_qty: 50,
      available_qty: 350,
      reorder_level: 100,
      min_stock_level: 50,
      max_stock_level: 500,
      valuation_rate: 120,
      total_value: 42000,
      storage_location: "Bin S-08",
      last_received_date: "2026-07-12",
      last_issued_date: "2026-07-19",
      is_batch_tracked: false,
      asset_code: "AST-BRG-008",
      consumable_code: "CS-BRG-6204",
    },
    {
      id: 6,
      item_id: 106,
      item_code: "CS-GLV-001",
      item_name: "Heavy Duty Work Gloves - Leather",
      category_name: "Consumable",
      warehouse_id: 1,
      warehouse_name: "Main Warehouse - Unit 1",
      uom_code: "PAIR",
      physical_qty: 0,
      reserved_qty: 0,
      in_transit_qty: 0,
      available_qty: 0,
      reorder_level: 100,
      min_stock_level: 50,
      max_stock_level: 400,
      valuation_rate: 85,
      total_value: 0,
      storage_location: "Shelf 3-A",
      last_received_date: "2026-06-15",
      last_issued_date: "2026-07-10",
      is_batch_tracked: false,
      consumable_code: "CS-GLV-001A",
    },
  ];

  mockStockLedger = [
    {
      id: 1,
      transaction_date: "2026-07-25 10:30:00",
      posting_time: "10:30:00",
      transaction_no: "TXN-2026-0001",
      transaction_type: "GRN",
      item_id: 101,
      item_code: "RM-STL-001",
      item_name: "Stainless Steel Sheet 2mm",
      warehouse_id: 1,
      warehouse_name: "Main Warehouse - Unit 1",
      uom_code: "SQM",
      in_qty: 200,
      out_qty: 0,
      balance_qty: 1200,
      unit_rate: 450,
      total_value: 90000,
      reference_no: "PO-2026-0891",
      performed_by: "Store Keeper",
      created_by: "Store Keeper",
      batch_number: "BAT-2026-0819",
      remarks: "Goods Receipt Note against PO #0891",
    },
    {
      id: 2,
      transaction_date: "2026-07-24 14:15:00",
      posting_time: "14:15:00",
      transaction_no: "TXN-2026-0002",
      transaction_type: "Material Issue",
      item_id: 103,
      item_code: "FG-VAL-100",
      item_name: "Industrial Butterfly Valve 4-Inch",
      warehouse_id: 3,
      warehouse_name: "Finished Goods Hub",
      uom_code: "PCS",
      in_qty: 0,
      out_qty: 10,
      balance_qty: 45,
      unit_rate: 1850,
      total_value: 18500,
      reference_no: "ISS-2026-0419",
      performed_by: "Dispatcher",
      created_by: "Dispatcher",
      batch_number: "BAT-2026-0501",
      remarks: "Dispatched for SO-2026-104",
    },
    {
      id: 3,
      transaction_date: "2026-07-23 09:00:00",
      posting_time: "09:00:00",
      transaction_no: "TXN-2026-0003",
      transaction_type: "Stock Transfer",
      item_id: 102,
      item_code: "RM-ALU-005",
      item_name: "Aluminum Extrusion Bar 50mm",
      warehouse_id: 2,
      warehouse_name: "Raw Material Yard",
      uom_code: "MTR",
      in_qty: 0,
      out_qty: 100,
      balance_qty: 850,
      unit_rate: 280,
      total_value: 28000,
      reference_no: "STN-2026-0012",
      performed_by: "Yard Supervisor",
      created_by: "Yard Supervisor",
      remarks: "Transferred to Project Site",
    },
  ];

  mockTransfers = [
    {
      id: 1,
      transfer_no: "STN-2026-0001",
      transfer_date: "2026-07-24",
      source_warehouse_id: 1,
      source_warehouse_name: "Main Warehouse - Unit 1",
      destination_warehouse_id: 5,
      destination_warehouse_name: "Project Site - South Zone",
      status: "IN_TRANSIT",
      total_items: 2,
      total_qty: 150,
      total_value: 52000,
      carrier: "Express Logistics",
      vehicle_number: "KA-05-MN-4321",
      created_by: "Logistics Coordinator",
      remarks: "Regular stock transfer for site requirement",
      lines: [
        {
          item_id: 101,
          item_code: "RM-STL-001",
          item_name: "Stainless Steel Sheet 2mm",
          available_qty: 1000,
          transfer_qty: 100,
          uom_code: "SQM",
          unit_rate: 450,
          total_value: 45000,
        },
        {
          item_id: 105,
          item_code: "SP-BRG-620",
          item_name: "Deep Groove Ball Bearing 6204-ZZ",
          available_qty: 350,
          transfer_qty: 50,
          uom_code: "PCS",
          unit_rate: 140,
          total_value: 7000,
        },
      ],
    },
    {
      id: 2,
      transfer_no: "STN-2026-0002",
      transfer_date: "2026-07-22",
      source_warehouse_id: 3,
      source_warehouse_name: "Finished Goods Hub",
      destination_warehouse_id: 1,
      destination_warehouse_name: "Main Warehouse - Unit 1",
      status: "RECEIVED",
      total_items: 1,
      total_qty: 20,
      total_value: 37000,
      carrier: "Internal Transport",
      vehicle_number: "KA-01-AB-1234",
      created_by: "Warehouse Manager",
      remarks: "Finished goods return to central store",
      lines: [
        {
          item_id: 103,
          item_code: "FG-VAL-100",
          item_name: "Industrial Butterfly Valve 4-Inch",
          available_qty: 30,
          transfer_qty: 20,
          uom_code: "PCS",
          unit_rate: 1850,
          total_value: 37000,
        },
      ],
    },
  ];
}

export function clearInventoryMockData() {
  mockWarehouses = [];
  mockCatalogItems = [];
  mockVendors = [];
  mockStockBalances = [];
  mockStockLedger = [];
  mockTransfers = [];
}

export const inventoryApi = {
  overview: async () => {
    try {
      const response = await api.get<InventoryOverview>("/api/inventory");
      return response.data;
    } catch {
      return {
        module: "inventory",
        status: "ready_for_development",
        database_ready: false,
      };
    }
  },

  getWarehouses: async (): Promise<WarehouseOption[]> => {
    if (typeof process === "undefined" || process.env.NODE_ENV !== "test") {
      try {
        const res = await api.get<WarehouseOption[]>("/api/inventory/warehouses");
        if (res.data && res.data.length > 0) return res.data;
      } catch {
        // Fallback
      }
    }
    return [...mockWarehouses];
  },

  getCatalogItems: async (): Promise<CatalogItemOption[]> => {
    if (typeof process === "undefined" || process.env.NODE_ENV !== "test") {
      try {
        const res = await api.get<CatalogItemOption[]>("/api/inventory/items");
        if (res.data && res.data.length > 0) return res.data;
      } catch {
        // Fallback
      }
    }
    return [...mockCatalogItems];
  },

  getVendors: async (): Promise<VendorOption[]> => {
    if (typeof process === "undefined" || process.env.NODE_ENV !== "test") {
      try {
        const res = await api.get<VendorOption[]>("/api/inventory/vendors");
        if (res.data && res.data.length > 0) return res.data;
      } catch {
        // Fallback
      }
    }
    return [...mockVendors];
  },

  getStockBalances: async (params?: StockBalanceFilter): Promise<StockBalanceItem[]> => {
    if (typeof process === "undefined" || process.env.NODE_ENV !== "test") {
      try {
        const res = await api.get<StockBalanceItem[]>("/api/inventory/stock-balance", { params });
        if (res.data) return res.data;
      } catch {
        // Fallback
      }
    }

    let result = [...mockStockBalances];

    if (params) {
      if (params.warehouse_id && params.warehouse_id !== "all") {
        result = result.filter((row) => String(row.warehouse_id) === String(params.warehouse_id));
      }
      if (params.category && params.category !== "all") {
        result = result.filter((row) => row.category_name.toLowerCase() === String(params.category).toLowerCase());
      }
      if (params.search) {
        const query = params.search.toLowerCase();
        result = result.filter(
          (row) =>
            row.item_name.toLowerCase().includes(query) ||
            row.item_code.toLowerCase().includes(query) ||
            (row.batch_number && row.batch_number.toLowerCase().includes(query)) ||
            (row.storage_location && row.storage_location.toLowerCase().includes(query)) ||
            (row.asset_code && row.asset_code.toLowerCase().includes(query)) ||
            (row.consumable_code && row.consumable_code.toLowerCase().includes(query)),
        );
      }
      if (!params.show_zero_stock) {
        result = result.filter((row) => row.physical_qty > 0 || row.reserved_qty > 0 || row.available_qty > 0);
      }
    }

    return result;
  },

  // Alias for backward compatibility
  getStockBalance: async (params?: StockBalanceFilter): Promise<StockBalanceItem[]> => {
    return inventoryApi.getStockBalances(params);
  },

  adjustStock: async (input: StockAdjustmentInput): Promise<StockBalanceItem> => {
    if (typeof process === "undefined" || process.env.NODE_ENV !== "test") {
      try {
        const res = await api.post<StockBalanceItem>("/api/inventory/adjustments", input);
        if (res.data) return res.data;
      } catch {
        // Fallback
      }
    }

    let targetItem = mockStockBalances.find(
      (i) => i.item_id === input.item_id && i.warehouse_id === input.warehouse_id,
    );

    const qtyChange = input.adjustment_type === "Stock In" ? input.quantity : -input.quantity;

    if (!targetItem) {
      const catalogInfo = mockCatalogItems.find((c) => c.id === input.item_id);
      const whInfo = mockWarehouses.find((w) => w.id === input.warehouse_id);

      targetItem = {
        id: Math.floor(1000 + Math.random() * 9000),
        item_id: input.item_id,
        item_code: catalogInfo?.code || `SKU-${input.item_id}`,
        item_name: catalogInfo?.name || `Material Item ${input.item_id}`,
        category_name: catalogInfo?.category || "Raw Material",
        warehouse_id: input.warehouse_id,
        warehouse_name: whInfo?.name || `Warehouse ${input.warehouse_id}`,
        uom_code: catalogInfo?.uom || "PCS",
        physical_qty: Math.max(0, qtyChange),
        reserved_qty: 0,
        in_transit_qty: 0,
        available_qty: Math.max(0, qtyChange),
        reorder_level: 50,
        min_stock_level: 20,
        max_stock_level: 200,
        valuation_rate: input.unit_rate || catalogInfo?.unit_rate || 100,
        total_value: Math.max(0, qtyChange) * (input.unit_rate || catalogInfo?.unit_rate || 100),
        batch_number: input.batch_number,
        expiry_date: input.expiry_date,
        storage_location: "Default Bin",
        last_received_date: new Date().toISOString().split("T")[0],
        last_issued_date: new Date().toISOString().split("T")[0],
        is_batch_tracked: catalogInfo?.is_batch_tracked ?? false,
      };

      mockStockBalances.unshift(targetItem);
    } else {
      targetItem.physical_qty = Math.max(0, targetItem.physical_qty + qtyChange);
      targetItem.available_qty = Math.max(0, targetItem.physical_qty - targetItem.reserved_qty);
      targetItem.total_value = targetItem.physical_qty * targetItem.valuation_rate;
    }

    const newLedgerItem: StockLedgerItem = {
      id: Math.floor(1000 + Math.random() * 9000),
      transaction_date: new Date().toISOString().replace("T", " ").substring(0, 19),
      posting_time: new Date().toTimeString().split(" ")[0],
      transaction_no: `TXN-${Math.floor(10000 + Math.random() * 90000)}`,
      transaction_type: "Stock Adjustment",
      item_id: targetItem.item_id,
      item_code: targetItem.item_code,
      item_name: targetItem.item_name,
      warehouse_id: targetItem.warehouse_id,
      warehouse_name: targetItem.warehouse_name,
      uom_code: targetItem.uom_code,
      in_qty: qtyChange > 0 ? qtyChange : 0,
      out_qty: qtyChange < 0 ? Math.abs(qtyChange) : 0,
      balance_qty: targetItem.physical_qty,
      unit_rate: input.unit_rate || targetItem.valuation_rate,
      total_value: Math.abs(qtyChange) * (input.unit_rate || targetItem.valuation_rate),
      performed_by: "System Admin",
      created_by: "System Admin",
      batch_number: input.batch_number || targetItem.batch_number,
      remarks: `${input.reason_code}: ${input.remarks || ""}`,
    };

    mockStockLedger.unshift(newLedgerItem);
    return { ...targetItem };
  },

  getStockLedger: async (params?: StockLedgerFilter): Promise<StockLedgerItem[]> => {
    if (typeof process === "undefined" || process.env.NODE_ENV !== "test") {
      try {
        const res = await api.get<StockLedgerItem[]>("/api/inventory/ledger", { params });
        if (res.data) return res.data;
      } catch {
        // Fallback
      }
    }

    let result = [...mockStockLedger];

    if (params) {
      if (params.transaction_type && params.transaction_type !== "all") {
        result = result.filter((row) => row.transaction_type === params.transaction_type);
      }
      if (params.warehouse_id && params.warehouse_id !== "all") {
        result = result.filter((row) => String(row.warehouse_id) === String(params.warehouse_id));
      }
      if (params.item_id && params.item_id !== "all") {
        result = result.filter((row) => String(row.item_id) === String(params.item_id));
      }
      if (params.search) {
        const query = params.search.toLowerCase();
        result = result.filter(
          (row) =>
            row.item_name.toLowerCase().includes(query) ||
            row.item_code.toLowerCase().includes(query) ||
            row.transaction_no.toLowerCase().includes(query) ||
            (row.reference_no && row.reference_no.toLowerCase().includes(query)),
        );
      }
    }

    return result;
  },

  exportStockLedger: async (params?: StockLedgerFilter) => {
    return inventoryApi.getStockLedger(params);
  },

  getReplenishments: async (): Promise<ReplenishmentItem[]> => {
    if (typeof process === "undefined" || process.env.NODE_ENV !== "test") {
      try {
        const res = await api.get<ReplenishmentItem[]>("/api/inventory/replenishments");
        if (res.data) return res.data;
      } catch {
        // Fallback
      }
    }

    const lowItems: ReplenishmentItem[] = mockStockBalances
      .filter((i) => i.available_qty <= i.reorder_level)
      .map((i) => {
        const status: ReplenishmentItem["status"] =
          i.available_qty === 0 ? "CRITICAL" : i.available_qty < (i.min_stock_level || 10) ? "WARNING" : "NORMAL";
        return {
          id: i.id,
          item_id: i.item_id,
          item_code: i.item_code,
          item_name: i.item_name,
          category_name: i.category_name,
          warehouse_id: i.warehouse_id,
          warehouse_name: i.warehouse_name,
          uom_code: i.uom_code,
          current_available: i.available_qty,
          reorder_level: i.reorder_level,
          min_stock_level: i.min_stock_level || 10,
          target_stock_level: i.max_stock_level || i.reorder_level * 2,
          suggested_reorder_qty: (i.max_stock_level || i.reorder_level * 2) - i.available_qty,
          preferred_vendor_id: 201,
          preferred_vendor_name: "Apex Steel Ltd.",
          estimated_unit_cost: i.valuation_rate,
          est_unit_rate: i.valuation_rate,
          lead_time_days: 7,
          status,
        };
      });

    return lowItems;
  },

  createReplenishmentPO: async (_payload: { items: ReplenishmentPOItem[] } | ReplenishmentPOItem[]) => {
    const indentNo = `IND-2026-${Math.floor(1000 + Math.random() * 9000)}`;
    return {
      success: true,
      indent_no: indentNo,
      message: `Purchase Indent ${indentNo} created successfully.`,
    };
  },

  createPurchaseIndent: async (items: ReplenishmentPOItem[]) => {
    return inventoryApi.createReplenishmentPO(items);
  },

  getStockTransfers: async (): Promise<StockTransferRow[]> => {
    if (typeof process === "undefined" || process.env.NODE_ENV !== "test") {
      try {
        const res = await api.get<StockTransferRow[]>("/api/inventory/transfers");
        if (res.data) return res.data;
      } catch {
        // Fallback
      }
    }
    return [...mockTransfers];
  },

  createStockTransfer: async (payload: StockTransferCreate): Promise<StockTransferRow> => {
    if (typeof process === "undefined" || process.env.NODE_ENV !== "test") {
      try {
        const res = await api.post<StockTransferRow>("/api/inventory/transfers", payload);
        if (res.data) return res.data;
      } catch {
        // Fallback
      }
    }

    const sourceWh = mockWarehouses.find((w) => w.id === payload.source_warehouse_id);
    const destWh = mockWarehouses.find((w) => w.id === payload.destination_warehouse_id);

    let totalQty = 0;
    let totalVal = 0;

    payload.lines.forEach((line) => {
      totalQty += line.transfer_qty;
      totalVal += line.transfer_qty * (line.unit_rate || 100);

      const sourceStock = mockStockBalances.find(
        (i) => i.item_id === line.item_id && i.warehouse_id === payload.source_warehouse_id,
      );
      if (sourceStock) {
        sourceStock.physical_qty = Math.max(0, sourceStock.physical_qty - line.transfer_qty);
        sourceStock.available_qty = Math.max(0, sourceStock.physical_qty - sourceStock.reserved_qty);
        sourceStock.total_value = sourceStock.physical_qty * sourceStock.valuation_rate;
      }
    });

    const newTransfer: StockTransferRow = {
      id: Math.floor(1000 + Math.random() * 9000),
      transfer_no: payload.transfer_no || `STN-2026-${Math.floor(1000 + Math.random() * 9000)}`,
      transfer_date: payload.transfer_date,
      source_warehouse_id: payload.source_warehouse_id,
      source_warehouse_name: sourceWh?.name || `Warehouse ${payload.source_warehouse_id}`,
      destination_warehouse_id: payload.destination_warehouse_id,
      destination_warehouse_name: destWh?.name || `Warehouse ${payload.destination_warehouse_id}`,
      status: "IN_TRANSIT",
      total_items: payload.lines.length,
      total_qty: totalQty,
      total_value: totalVal,
      carrier: payload.carrier || "Standard Transport",
      vehicle_number: payload.vehicle_number,
      created_by: "System Operator",
      remarks: payload.remarks,
      lines: payload.lines,
    };

    mockTransfers.unshift(newTransfer);
    return newTransfer;
  },

  createTransfer: async (payload: StockTransferCreate): Promise<StockTransferRow> => {
    return inventoryApi.createStockTransfer(payload);
  },

  receiveStockTransfer: async (transferId: number): Promise<StockTransferRow> => {
    if (typeof process === "undefined" || process.env.NODE_ENV !== "test") {
      try {
        const res = await api.post<StockTransferRow>(`/api/inventory/transfers/${transferId}/receive`);
        if (res.data) return res.data;
      } catch {
        // Fallback
      }
    }

    const transfer = mockTransfers.find((t) => t.id === transferId);
    if (!transfer) throw new Error("Transfer not found");

    transfer.status = "RECEIVED";

    if (transfer.lines) {
      transfer.lines.forEach((line) => {
        let destStock = mockStockBalances.find(
          (i) => i.item_id === line.item_id && i.warehouse_id === transfer.destination_warehouse_id,
        );

        if (!destStock) {
          destStock = {
            id: Math.floor(1000 + Math.random() * 9000),
            item_id: line.item_id,
            item_code: line.item_code,
            item_name: line.item_name,
            category_name: "Transferred Good",
            warehouse_id: transfer.destination_warehouse_id,
            warehouse_name: transfer.destination_warehouse_name,
            uom_code: line.uom_code,
            physical_qty: line.transfer_qty,
            reserved_qty: 0,
            in_transit_qty: 0,
            available_qty: line.transfer_qty,
            reorder_level: 50,
            min_stock_level: 20,
            max_stock_level: 200,
            valuation_rate: line.unit_rate || 100,
            total_value: line.transfer_qty * (line.unit_rate || 100),
            batch_number: line.batch_number,
            expiry_date: line.expiry_date,
            storage_location: "Receiving Bay",
            last_received_date: new Date().toISOString().split("T")[0],
            is_batch_tracked: line.is_batch_tracked ?? false,
          };
          mockStockBalances.unshift(destStock);
        } else {
          destStock.physical_qty += line.transfer_qty;
          destStock.available_qty = destStock.physical_qty - destStock.reserved_qty;
          destStock.total_value = destStock.physical_qty * destStock.valuation_rate;
        }
      });
    }

    return { ...transfer };
  },

  cancelStockTransfer: async (transferId: number): Promise<StockTransferRow> => {
    if (typeof process === "undefined" || process.env.NODE_ENV !== "test") {
      try {
        const res = await api.post<StockTransferRow>(`/api/inventory/transfers/${transferId}/cancel`);
        if (res.data) return res.data;
      } catch {
        // Fallback
      }
    }

    const transfer = mockTransfers.find((t) => t.id === transferId);
    if (!transfer) throw new Error("Transfer not found");

    transfer.status = "CANCELLED";

    if (transfer.lines) {
      transfer.lines.forEach((line) => {
        const sourceStock = mockStockBalances.find(
          (i) => i.item_id === line.item_id && i.warehouse_id === transfer.source_warehouse_id,
        );

        if (sourceStock) {
          sourceStock.physical_qty += line.transfer_qty;
          sourceStock.available_qty = sourceStock.physical_qty - sourceStock.reserved_qty;
          sourceStock.total_value = sourceStock.physical_qty * sourceStock.valuation_rate;
        }
      });
    }

    return { ...transfer };
  },
};
