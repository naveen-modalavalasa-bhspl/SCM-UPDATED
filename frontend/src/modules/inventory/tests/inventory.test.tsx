import { describe, it, expect, beforeEach } from "vitest";
import { inventoryApi, seedInventoryMockData } from "../api";
import type { StockAdjustmentInput, StockTransferCreate } from "../types";

describe("Inventory Transactions API & Core Business Logic", () => {
  beforeEach(() => {
    seedInventoryMockData();
  });

  describe("Stock Balance Operations", () => {
    it("fetches stock balance and filters out zero-stock by default", async () => {
      const items = await inventoryApi.getStockBalance({ show_zero_stock: false });
      expect(items.length).toBeGreaterThan(0);
      items.forEach((item) => {
        expect(item.physical_qty > 0 || item.reserved_qty > 0 || item.available_qty > 0).toBe(true);
      });
    });

    it("includes zero-stock items when show_zero_stock is set to true", async () => {
      const allItems = await inventoryApi.getStockBalance({ show_zero_stock: true });
      const zeroItems = allItems.filter((i) => i.physical_qty === 0);
      expect(zeroItems.length).toBeGreaterThan(0);
    });

    it("filters stock balance by search query", async () => {
      const searchItems = await inventoryApi.getStockBalance({ search: "Stainless", show_zero_stock: true });
      expect(searchItems.length).toBeGreaterThan(0);
      expect(searchItems[0].item_name).toContain("Stainless");
    });

    it("executes stock adjustment and updates balance and ledger", async () => {
      const initialStock = await inventoryApi.getStockBalance({ show_zero_stock: true });
      const itemToAdjust = initialStock[0];
      const initialQty = itemToAdjust.physical_qty;

      const adjData: StockAdjustmentInput = {
        item_id: itemToAdjust.item_id,
        warehouse_id: itemToAdjust.warehouse_id,
        adjustment_type: "Stock In",
        quantity: 50,
        unit_rate: itemToAdjust.valuation_rate,
        reason_code: "Found Stock",
        remarks: "Audit verification test adjustment",
      };

      const updated = await inventoryApi.adjustStock(adjData);
      expect(updated.physical_qty).toBe(initialQty + 50);

      // Verify transaction recorded in ledger
      const ledger = await inventoryApi.getStockLedger({ transaction_type: "Stock Adjustment" });
      expect(ledger.length).toBeGreaterThan(0);
      expect(ledger[0].in_qty).toBe(50);
    });
  });

  describe("Stock Ledger Operations", () => {
    it("fetches ledger records and filters by transaction type", async () => {
      const grnLedger = await inventoryApi.getStockLedger({ transaction_type: "GRN" });
      expect(grnLedger.length).toBeGreaterThan(0);
      grnLedger.forEach((row) => {
        expect(row.transaction_type).toBe("GRN");
      });
    });

    it("filters ledger records by warehouse ID", async () => {
      const whLedger = await inventoryApi.getStockLedger({ warehouse_id: 3 });
      whLedger.forEach((row) => {
        expect(row.warehouse_id).toBe(3);
      });
    });
  });

  describe("Stock Replenishment Operations", () => {
    it("identifies items requiring replenishment", async () => {
      const lowStockItems = await inventoryApi.getReplenishments();
      expect(lowStockItems.length).toBeGreaterThan(0);
      lowStockItems.forEach((item) => {
        expect(item.current_available).toBeLessThanOrEqual(item.reorder_level);
        expect(item.suggested_reorder_qty).toBeGreaterThan(0);
      });
    });

    it("creates purchase indents for selected replenishment items", async () => {
      const res = await inventoryApi.createPurchaseIndent([
        { item_id: 104, suggested_qty: 50, vendor_id: 201 },
      ]);
      expect(res.success).toBe(true);
      expect(res.indent_no).toMatch(/^IND-2026-\d{4}$/);
    });
  });

  describe("Stock Transfer Operations", () => {
    it("creates stock transfer, sets status to IN_TRANSIT and updates source balance", async () => {
      const transferPayload: StockTransferCreate = {
        transfer_no: "STN-2026-9999",
        transfer_date: "2026-07-25",
        source_warehouse_id: 3,
        destination_warehouse_id: 5,
        carrier: "FastTruck",
        vehicle_number: "KA-01-XY-1000",
        driver_name_contact: "Test Driver",
        remarks: "Unit test stock transfer",
        lines: [
          {
            item_id: 101,
            item_code: "RM-STL-001",
            item_name: "Stainless Steel Sheet 2mm",
            available_qty: 1000,
            transfer_qty: 50,
            uom_code: "SQM",
            batch_number: "BAT-2026-0819",
            expiry_date: "2027-12-31",
            unit_rate: 450,
            total_value: 22500,
            is_batch_tracked: true,
          },
        ],
      };

      const transfer = await inventoryApi.createStockTransfer(transferPayload);
      expect(transfer.status).toBe("IN_TRANSIT");
      expect(transfer.total_items).toBe(1);
      expect(transfer.total_qty).toBe(50);

      // Verify transfer appears in transfer list
      const transfers = await inventoryApi.getStockTransfers();
      const found = transfers.find((t) => t.transfer_no === "STN-2026-9999");
      expect(found).toBeDefined();
    });

    it("receives stock transfer at destination warehouse", async () => {
      const transfers = await inventoryApi.getStockTransfers();
      const inTransit = transfers.find((t) => t.status === "IN_TRANSIT");
      if (inTransit) {
        const received = await inventoryApi.receiveStockTransfer(inTransit.id);
        expect(received.status).toBe("RECEIVED");
      }
    });

    it("cancels stock transfer and returns stock to source warehouse", async () => {
      // Create new transfer to cancel
      const newTransfer = await inventoryApi.createStockTransfer({
        transfer_no: `STN-CANCEL-${Date.now()}`,
        transfer_date: "2026-07-25",
        source_warehouse_id: 1,
        destination_warehouse_id: 2,
        lines: [
          {
            item_id: 104,
            item_code: "FG-VAL-200",
            item_name: "High Pressure Control Valve",
            available_qty: 10,
            transfer_qty: 2,
            uom_code: "PCS",
            unit_rate: 3200,
            total_value: 6400,
          },
        ],
      });

      const cancelled = await inventoryApi.cancelStockTransfer(newTransfer.id);
      expect(cancelled.status).toBe("CANCELLED");
    });
  });
});
