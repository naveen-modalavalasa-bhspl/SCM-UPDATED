import { useState, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  ArrowRight,
  Plus,
  Trash2,
  CheckCircle,
  Truck,
  Eye,
  FileText,
  Calendar,
  AlertCircle,
  MapPin,
} from "lucide-react";
import {
  Chip,
  Tabs,
  Tab,
  Modal,
  ModalContent,
  ModalHeader,
  ModalBody,
  ModalFooter,
  Textarea,
} from "@heroui/react";
import { Button, Input, Select, ResponsiveList, StatusPill, type Column } from "@/shared/components";
import { inventoryApi } from "../api";
import type {
  CatalogItemOption,
  StockBalanceItem,
  StockTransferCreate,
  StockTransferLineItem,
  StockTransferRow,
  WarehouseOption,
} from "../types";

export function StockTransferView() {
  const queryClient = useQueryClient();
  const [activeTab, setActiveTab] = useState<"list" | "create">("list");
  const [selectedViewTransfer, setSelectedViewTransfer] = useState<StockTransferRow | null>(null);

  // Transfer Creation Form State
  const autoGenNo = useMemo(() => `STN-2026-${Math.floor(1000 + Math.random() * 9000)}`, []);
  const todayStr = useMemo(() => new Date().toISOString().substring(0, 10), []);

  const [transferNo, setTransferNo] = useState(autoGenNo);
  const [transferDate, setTransferDate] = useState(todayStr);
  const [sourceWhId, setSourceWhId] = useState<number | "">("");
  const [destWhId, setDestWhId] = useState<number | "">("");
  const [carrier, setCarrier] = useState("");
  const [vehicleNo, setVehicleNo] = useState("");
  const [driverContact, setDriverContact] = useState("");
  const [remarks, setRemarks] = useState("");
  const [formError, setFormError] = useState("");
  const [lineItems, setLineItems] = useState<StockTransferLineItem[]>([]);

  // Data Queries
  const { data: warehouses = [] } = useQuery<WarehouseOption[]>({
    queryKey: ["inventory-warehouses"],
    queryFn: inventoryApi.getWarehouses,
  });

  const { data: catalog = [] } = useQuery<CatalogItemOption[]>({
    queryKey: ["inventory-catalog"],
    queryFn: inventoryApi.getCatalogItems,
  });

  const { data: sourceStockList = [] } = useQuery<StockBalanceItem[]>({
    queryKey: ["stock-balance-source", sourceWhId],
    queryFn: () => (sourceWhId ? inventoryApi.getStockBalances({ warehouse_id: sourceWhId }) : Promise.resolve([])),
    enabled: Boolean(sourceWhId),
  });

  const { data: stoPage, isLoading } = useQuery({
    queryKey: ["stock-transfers"],
    queryFn: () => inventoryApi.listSTOs(),
  });

  const transfersList = useMemo(() => {
    if (!stoPage?.items) return [];
    return stoPage.items.map((sto: any) => ({
      id: sto.id,
      transfer_no: sto.sto_no,
      transfer_date: sto.created_at ? sto.created_at.substring(0, 10) : "",
      source_warehouse_id: sto.from_warehouse_id,
      source_warehouse_name: sto.from_warehouse_name || `Warehouse #${sto.from_warehouse_id}`,
      destination_warehouse_id: sto.to_warehouse_id,
      destination_warehouse_name: sto.to_warehouse_name || `Warehouse #${sto.to_warehouse_id}`,
      status: sto.status,
      total_items: sto.items ? sto.items.length : 0,
      total_qty: sto.items ? sto.items.reduce((acc: number, it: any) => acc + (it.requested_qty || 0), 0) : 0,
      total_value: 0,
      created_by: sto.requested_by_name || "System",
      remarks: sto.remarks,
      lines: sto.items ? sto.items.map((it: any) => ({
        item_id: it.item_id,
        item_code: it.item_code,
        item_name: it.item_name,
        available_qty: it.requested_qty,
        transfer_qty: it.requested_qty,
        uom_code: it.uom_code,
      })) : [],
    }));
  }, [stoPage]);

  // Mutations
  const createMutation = useMutation({
    mutationFn: (payload: StockTransferCreate) =>
      inventoryApi.createSTO({
        from_warehouse_id: payload.source_warehouse_id,
        to_warehouse_id: payload.destination_warehouse_id,
        remarks: payload.remarks,
        items: payload.lines.map((l) => ({
          item_id: l.item_id,
          requested_qty: l.transfer_qty,
          remarks: l.batch_number ? `Batch: ${l.batch_number}` : undefined,
        })),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["stock-transfers"] });
      queryClient.invalidateQueries({ queryKey: ["stock-balance"] });
      setActiveTab("list");
      resetCreateForm();
    },
    onError: (err: any) => {
      setFormError(err?.response?.data?.detail || err?.message || "Failed to create STO");
    },
  });

  const approveMutation = useMutation({
    mutationFn: (id: number) => inventoryApi.approveSTO(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["stock-transfers"] });
    },
  });

  const dispatchMutation = useMutation({
    mutationFn: (id: number) => inventoryApi.dispatchSTO(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["stock-transfers"] });
    },
  });

  const receiveMutation = useMutation({
    mutationFn: (id: number) => inventoryApi.receiveSTO(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["stock-transfers"] });
      queryClient.invalidateQueries({ queryKey: ["stock-balance"] });
    },
  });

  const resetCreateForm = () => {
    setTransferNo(`STN-2026-${Math.floor(1000 + Math.random() * 9000)}`);
    setTransferDate(new Date().toISOString().substring(0, 10));
    setSourceWhId("");
    setDestWhId("");
    setCarrier("");
    setVehicleNo("");
    setDriverContact("");
    setRemarks("");
    setFormError("");
    setLineItems([]);
  };

  const warehouseOptions = useMemo(
    () => warehouses.map((w) => ({ value: w.id, label: `${w.code} - ${w.name}` })),
    [warehouses]
  );

  const handleAddLineRow = () => {
    if (!sourceWhId) {
      setFormError("Select Source Warehouse first to choose available items.");
      return;
    }
    setFormError("");
    setLineItems((prev) => [
      ...prev,
      {
        id: Date.now(),
        item_id: 0,
        item_code: "",
        item_name: "",
        available_qty: 0,
        transfer_qty: 1,
        uom_code: "PCS",
        unit_rate: 0,
        total_value: 0,
      },
    ]);
  };

  const handleUpdateLine = (index: number, field: keyof StockTransferLineItem, value: any) => {
    const next = [...lineItems];
    const item = { ...next[index] };

    if (field === "item_id") {
      const selectedId = Number(value);
      const catItem = catalog.find((c) => c.id === selectedId);
      const stockItem = sourceStockList.find((s) => s.item_id === selectedId);

      item.item_id = selectedId;
      item.item_code = catItem?.code ?? stockItem?.item_code ?? "";
      item.item_name = catItem?.name ?? stockItem?.item_name ?? "";
      item.uom_code = catItem?.uom_code ?? stockItem?.uom_code ?? "PCS";
      item.available_qty = stockItem ? stockItem.available_qty : 0;
      item.unit_rate = stockItem ? stockItem.valuation_rate : catItem?.default_unit_rate ?? 0;
      item.batch_number = stockItem?.batch_number || undefined;
      item.expiry_date = stockItem?.expiry_date || undefined;
      item.is_batch_tracked = catItem?.is_batch_tracked ?? false;
      item.transfer_qty = 1;
      item.total_value = item.transfer_qty * (item.unit_rate ?? 0);
    } else if (field === "transfer_qty") {
      const qty = Number(value);
      item.transfer_qty = qty;
      item.total_value = qty * (item.unit_rate ?? 0);
    } else {
      (item as any)[field] = value;
    }

    next[index] = item;
    setLineItems(next);
  };

  const handleRemoveLine = (index: number) => {
    setLineItems((prev) => prev.filter((_, i) => i !== index));
  };

  const handleCreateSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setFormError("");

    if (!transferNo.trim()) {
      setFormError("Transfer Number is required.");
      return;
    }
    if (!sourceWhId) {
      setFormError("Source Warehouse is required.");
      return;
    }
    if (!destWhId) {
      setFormError("Destination Warehouse is required.");
      return;
    }
    if (sourceWhId === destWhId) {
      setFormError("Destination Warehouse MUST differ from Source Warehouse.");
      return;
    }
    if (lineItems.length === 0) {
      setFormError("At least one line item must be added to transfer.");
      return;
    }

    // Validate line items
    for (let i = 0; i < lineItems.length; i++) {
      const line = lineItems[i];
      if (!line.item_id) {
        setFormError(`Line #${i + 1}: Please select an item.`);
        return;
      }
      if (line.transfer_qty <= 0) {
        setFormError(`Line #${i + 1} (${line.item_code}): Transfer quantity must be greater than 0.`);
        return;
      }
      if (line.transfer_qty > line.available_qty) {
        setFormError(
          `Line #${i + 1} (${line.item_code}): Transfer quantity (${line.transfer_qty}) exceeds available stock (${line.available_qty}).`
        );
        return;
      }
      if (line.is_batch_tracked && !line.batch_number) {
        setFormError(`Line #${i + 1} (${line.item_code}): Batch Number is required for batch tracked item.`);
        return;
      }
    }

    createMutation.mutate({
      transfer_no: transferNo,
      transfer_date: transferDate,
      source_warehouse_id: Number(sourceWhId),
      destination_warehouse_id: Number(destWhId),
      carrier: carrier || undefined,
      vehicle_number: vehicleNo || undefined,
      driver_name_contact: driverContact || undefined,
      remarks: remarks || undefined,
      lines: lineItems,
    });
  };

  const listColumns: Column<StockTransferRow>[] = [
    {
      key: "transfer_no",
      header: "Transfer No",
      render: (r) => (
        <span
          onClick={() => setSelectedViewTransfer(r)}
          className="mono font-bold text-xs text-brand hover:underline cursor-pointer"
        >
          {r.transfer_no}
        </span>
      ),
    },
    {
      key: "transfer_date",
      header: "Transfer Date",
      render: (r) => <span className="mono text-xs text-muted">{r.transfer_date}</span>,
    },
    {
      key: "source_warehouse_name",
      header: "Source Warehouse",
      render: (r) => (
        <Chip size="sm" variant="bordered">
          {r.source_warehouse_name}
        </Chip>
      ),
    },
    {
      key: "dest_warehouse_name",
      header: "Destination Warehouse",
      render: (r) => (
        <Chip size="sm" variant="flat" color="primary">
          {r.destination_warehouse_name}
        </Chip>
      ),
    },
    {
      key: "total_items_qty",
      header: "Total Items / Qty",
      render: (r) => (
        <span className="tabular font-medium text-body">
          {r.total_items} SKUs ({r.total_qty.toLocaleString("en-IN")} total qty)
        </span>
      ),
    },
    {
      key: "status",
      header: "Transfer Status",
      render: (r) => <StatusPill status={r.status} />,
    },
    {
      key: "actions",
      header: "Actions",
      render: (r) => (
        <div className="flex items-center gap-1.5">
          <Button variant="ghost" onClick={() => setSelectedViewTransfer(r)}>
            <Eye className="h-3.5 w-3.5" /> View
          </Button>

          {r.status === "PENDING_APPROVAL" && (
            <Button
              variant="primary"
              onClick={() => approveMutation.mutate(r.id)}
              disabled={approveMutation.isPending}
            >
              <CheckCircle className="h-3.5 w-3.5" /> Approve STO
            </Button>
          )}

          {r.status === "APPROVED" && (
            <Button
              variant="secondary"
              onClick={() => dispatchMutation.mutate(r.id)}
              disabled={dispatchMutation.isPending}
            >
              <Truck className="h-3.5 w-3.5" /> Dispatch
            </Button>
          )}

          {(r.status === "DISPATCHED" || r.status === "IN_TRANSIT") && (
            <Button
              variant="primary"
              onClick={() => receiveMutation.mutate(r.id)}
              disabled={receiveMutation.isPending}
            >
              <CheckCircle className="h-3.5 w-3.5" /> Receive at Dest
            </Button>
          )}
        </div>
      ),
    },
  ];

  return (
    <div className="space-y-6">
      {/* Tab Controls */}
      <div className="flex items-center justify-between border-b border-line pb-3">
        <Tabs
          selectedKey={activeTab}
          onSelectionChange={(k) => setActiveTab(k as any)}
          variant="solid"
          color="primary"
          radius="full"
        >
          <Tab key="list" title="Transfers Overview" />
          <Tab key="create" title="+ Create New Transfer" />
        </Tabs>
      </div>

      {activeTab === "list" ? (
        /* 4.3 Transfer List View Table */
        <ResponsiveList
          data={transfersList}
          columns={listColumns}
          loading={isLoading}
          keyOf={(r) => r.id}
          empty="No stock transfer records found."
          renderCard={(r) => (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <span className="mono font-bold text-brand">{r.transfer_no}</span>
                <StatusPill status={r.status} />
              </div>

              <div className="flex items-center gap-2 text-xs font-semibold text-body">
                <span>{r.source_warehouse_name}</span>
                <ArrowRight className="h-3.5 w-3.5 text-muted" />
                <span>{r.destination_warehouse_name}</span>
              </div>

              <div className="flex items-center justify-between text-xs text-muted pt-1">
                <span>{r.transfer_date}</span>
                <span className="font-bold text-ink">{r.total_items} items ({r.total_qty} qty)</span>
              </div>
            </div>
          )}
        />
      ) : (
        /* 4.1 & 4.2 Stock Transfer Creation Form & Line Items */
        <form onSubmit={handleCreateSubmit} className="space-y-6">
          {formError && (
            <div className="flex items-center gap-2 rounded-xl bg-danger-50 p-4 text-xs font-bold text-danger border border-danger-200">
              <AlertCircle className="h-4 w-4 shrink-0" />
              <span>{formError}</span>
            </div>
          )}

          {/* 4.1 Header Form Fields */}
          <div className="rounded-2xl border border-line bg-content1 p-5 shadow-sm space-y-4">
            <h3 className="text-sm font-bold text-ink uppercase tracking-wider flex items-center gap-2 border-b border-line pb-3">
              <Truck className="h-4 w-4 text-brand" /> Transfer Header & Carrier Info
            </h3>

            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-4">
              <div className="space-y-1">
                <label className="text-xs font-semibold text-body">Transfer Number *</label>
                <Input
                  value={transferNo}
                  onChange={(e) => setTransferNo(e.target.value)}
                  placeholder="STN-YYYY-XXXX"
                />
              </div>

              <div className="space-y-1">
                <label className="text-xs font-semibold text-body">Transfer Date *</label>
                <Input
                  type="date"
                  value={transferDate}
                  onChange={(e) => setTransferDate(e.target.value)}
                />
              </div>

              <div className="space-y-1">
                <label className="text-xs font-semibold text-body">Source Warehouse *</label>
                <Select
                  placeholder="Select origin warehouse..."
                  options={warehouseOptions}
                  value={sourceWhId}
                  onChange={(v) => {
                    setSourceWhId(v ? Number(v) : "");
                    setLineItems([]); // reset line items on source change
                  }}
                />
              </div>

              <div className="space-y-1">
                <label className="text-xs font-semibold text-body">Destination Warehouse *</label>
                <Select
                  placeholder="Select target warehouse..."
                  options={warehouseOptions}
                  value={destWhId}
                  onChange={(v) => setDestWhId(v ? Number(v) : "")}
                />
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 pt-2">
              <div className="space-y-1">
                <label className="text-xs font-semibold text-muted">Carrier / Transporter</label>
                <Input
                  placeholder="Logistics company name"
                  value={carrier}
                  onChange={(e) => setCarrier(e.target.value)}
                />
              </div>

              <div className="space-y-1">
                <label className="text-xs font-semibold text-muted">Vehicle Number</label>
                <Input
                  placeholder="e.g. KA-01-EQ-9876"
                  value={vehicleNo}
                  onChange={(e) => setVehicleNo(e.target.value)}
                />
              </div>

              <div className="space-y-1">
                <label className="text-xs font-semibold text-muted">Driver Name & Contact</label>
                <Input
                  placeholder="e.g. Ramesh (+91 98765...)"
                  value={driverContact}
                  onChange={(e) => setDriverContact(e.target.value)}
                />
              </div>
            </div>

            <div className="space-y-1 pt-2">
              <label className="text-xs font-semibold text-muted">Remarks / Notes</label>
              <Textarea
                placeholder="Transfer reasons or dispatch instructions..."
                value={remarks}
                onValueChange={setRemarks}
              />
            </div>
          </div>

          {/* 4.2 Transfer Line Items Table */}
          <div className="rounded-2xl border border-line bg-content1 p-5 shadow-sm space-y-4">
            <div className="flex items-center justify-between border-b border-line pb-3">
              <h3 className="text-sm font-bold text-ink uppercase tracking-wider flex items-center gap-2">
                <FileText className="h-4 w-4 text-brand" /> Transfer Line Items ({lineItems.length})
              </h3>

              <Button type="button" variant="primary" onClick={handleAddLineRow}>
                <Plus className="h-4 w-4" /> Add Row
              </Button>
            </div>

            {lineItems.length === 0 ? (
              <div className="py-12 text-center text-muted border border-dashed border-line rounded-xl">
                No items added yet. Click &quot;Add Row&quot; above to include SKUs for transfer.
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm border-collapse">
                  <thead>
                    <tr className="border-b border-line bg-content2 text-[11px] font-semibold uppercase tracking-wider text-muted">
                      <th className="p-3">Item *</th>
                      <th className="p-3">Available Qty</th>
                      <th className="p-3 w-32">Transfer Qty *</th>
                      <th className="p-3">UOM</th>
                      <th className="p-3">Batch Number</th>
                      <th className="p-3">Expiry Date</th>
                      <th className="p-3">Unit Rate</th>
                      <th className="p-3">Total Value</th>
                      <th className="p-3 text-center">Action</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {lineItems.map((line, idx) => {
                      const availItemOptions = catalog.map((c) => ({
                        value: c.id,
                        label: `${c.code} - ${c.name}`,
                      }));

                      return (
                        <tr key={idx} className="hover:bg-content2/50 transition">
                          <td className="p-3 min-w-[200px]">
                            <Select
                              placeholder="Select SKU..."
                              options={availItemOptions}
                              value={line.item_id || ""}
                              onChange={(v) => handleUpdateLine(idx, "item_id", v)}
                            />
                          </td>

                          <td className="p-3 font-semibold text-body">
                            {line.available_qty.toLocaleString("en-IN")}
                          </td>

                          <td className="p-3">
                            <Input
                              type="number"
                              min="0.01"
                              step="0.01"
                              max={line.available_qty || undefined}
                              value={line.transfer_qty}
                              onChange={(e) => handleUpdateLine(idx, "transfer_qty", e.target.value)}
                              className="font-bold"
                            />
                          </td>

                          <td className="p-3 text-xs font-semibold text-muted">
                            {line.uom_code}
                          </td>

                          <td className="p-3">
                            {line.is_batch_tracked ? (
                              <Input
                                placeholder="Batch ID"
                                value={line.batch_number || ""}
                                onChange={(e) => handleUpdateLine(idx, "batch_number", e.target.value)}
                              />
                            ) : (
                              <span className="text-xs text-muted">—</span>
                            )}
                          </td>

                          <td className="p-3 text-xs text-muted">
                            {line.expiry_date || "—"}
                          </td>

                          <td className="p-3 text-body">
                            ₹{(line.unit_rate ?? 0).toLocaleString("en-IN", { minimumFractionDigits: 2 })}
                          </td>

                          <td className="p-3 font-bold text-ink">
                            ₹{(line.total_value ?? 0).toLocaleString("en-IN", { minimumFractionDigits: 2 })}
                          </td>

                          <td className="p-3 text-center">
                            <button
                              type="button"
                              onClick={() => handleRemoveLine(idx)}
                              className="p-1.5 rounded-lg text-danger hover:bg-danger-50 transition"
                              title="Delete Row"
                            >
                              <Trash2 className="h-4 w-4" />
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <div className="flex justify-end gap-3 pt-2">
            <Button type="button" variant="ghost" onClick={() => setActiveTab("list")}>
              Cancel
            </Button>

            <Button type="submit" variant="primary" disabled={createMutation.isPending}>
              {createMutation.isPending ? "Creating Transfer..." : "Submit Stock Transfer"}
            </Button>
          </div>
        </form>
      )}

      {/* Transfer Detail Inspection Modal */}
      <Modal
        isOpen={!!selectedViewTransfer}
        onClose={() => setSelectedViewTransfer(null)}
        size="2xl"
      >
        <ModalContent className="border border-line bg-content1 shadow-2xl">
          {selectedViewTransfer && (
            <>
              <ModalHeader className="flex items-center justify-between border-b border-line pb-3">
                <div className="flex items-center gap-2">
                  <Truck className="h-5 w-5 text-brand" />
                  <span className="text-lg font-bold text-ink">
                    Transfer #{selectedViewTransfer.transfer_no}
                  </span>
                </div>
                <StatusPill status={selectedViewTransfer.status} />
              </ModalHeader>

              <ModalBody className="py-5 space-y-4 max-h-[75vh] overflow-y-auto">
                <div className="grid grid-cols-2 gap-4 rounded-xl border border-line p-4 bg-content2/50 text-xs">
                  <div className="space-y-1">
                    <span className="text-muted flex items-center gap-1"><MapPin className="h-3.5 w-3.5" /> Source:</span>
                    <span className="font-bold text-ink text-sm">{selectedViewTransfer.source_warehouse_name}</span>
                  </div>

                  <div className="space-y-1">
                    <span className="text-muted flex items-center gap-1"><MapPin className="h-3.5 w-3.5 text-brand" /> Destination:</span>
                    <span className="font-bold text-ink text-sm">{selectedViewTransfer.destination_warehouse_name}</span>
                  </div>

                  <div className="space-y-1">
                    <span className="text-muted flex items-center gap-1"><Calendar className="h-3.5 w-3.5" /> Transfer Date:</span>
                    <span className="font-semibold text-ink">{selectedViewTransfer.transfer_date}</span>
                  </div>

                  <div className="space-y-1">
                    <span className="text-muted flex items-center gap-1"><Truck className="h-3.5 w-3.5" /> Transporter / Carrier:</span>
                    <span className="font-semibold text-ink">{selectedViewTransfer.carrier || "N/A"} ({selectedViewTransfer.vehicle_number || "No vehicle"})</span>
                  </div>
                </div>

                <div className="space-y-2">
                  <h4 className="text-xs font-bold uppercase tracking-wider text-muted">
                    Transfer Line Items ({(selectedViewTransfer.lines || []).length})
                  </h4>

                  <div className="rounded-xl border border-line overflow-hidden">
                    <table className="w-full text-left text-xs">
                      <thead className="bg-content2 border-b border-line font-semibold text-muted uppercase">
                        <tr>
                          <th className="p-2.5">Item Code & Name</th>
                          <th className="p-2.5">Qty</th>
                          <th className="p-2.5">Batch</th>
                          <th className="p-2.5">Unit Rate</th>
                          <th className="p-2.5">Total Value</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-line">
                        {(selectedViewTransfer.lines || []).map((l, i) => (
                          <tr key={i}>
                            <td className="p-2.5 font-bold text-ink">
                              {l.item_code} - {l.item_name}
                            </td>
                            <td className="p-2.5 font-semibold text-brand">
                              {l.transfer_qty} {l.uom_code}
                            </td>
                            <td className="p-2.5 text-muted">{l.batch_number || "—"}</td>
                            <td className="p-2.5">₹{(l.unit_rate ?? 0).toLocaleString("en-IN")}</td>
                            <td className="p-2.5 font-bold text-ink">₹{(l.total_value ?? 0).toLocaleString("en-IN")}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>

                {selectedViewTransfer.remarks && (
                  <div className="text-xs text-muted pt-2 border-t border-line">
                    <span className="font-semibold block text-body">Remarks:</span>
                    <p className="italic">{selectedViewTransfer.remarks}</p>
                  </div>
                )}
              </ModalBody>

              <ModalFooter className="border-t border-line">
                <Button variant="ghost" onClick={() => setSelectedViewTransfer(null)}>
                  Close
                </Button>

                {selectedViewTransfer.status === "IN_TRANSIT" && (
                  <Button
                    variant="primary"
                    onClick={() => {
                      receiveMutation.mutate(selectedViewTransfer.id);
                      setSelectedViewTransfer(null);
                    }}
                  >
                    Receive Stock at Destination
                  </Button>
                )}
              </ModalFooter>
            </>
          )}
        </ModalContent>
      </Modal>
    </div>
  );
}
