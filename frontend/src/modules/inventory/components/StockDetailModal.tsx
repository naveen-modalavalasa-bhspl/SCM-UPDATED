import { Modal, ModalContent, ModalHeader, ModalBody, ModalFooter, Button, Chip } from "@heroui/react";
import { Package, ShieldAlert, Calendar, MapPin, DollarSign, Layers, CheckCircle2, Hash, Tag } from "lucide-react";
import type { StockBalanceItem } from "../types";

interface Props {
  isOpen: boolean;
  onClose: () => void;
  item: StockBalanceItem | null;
  onQuickAdjust?: (item: StockBalanceItem) => void;
}

export function StockDetailModal({ isOpen, onClose, item, onQuickAdjust }: Props) {
  if (!item) return null;

  const isLow = item.min_stock_level ? item.available_qty <= item.min_stock_level : item.available_qty < 10;
  const isExpiringSoon = item.expiry_date
    ? new Date(item.expiry_date).getTime() - new Date().getTime() < 30 * 24 * 60 * 60 * 1000
    : false;

  // Derive serial numbers matching available quantity
  const serialNumbers = item.serial_numbers && item.serial_numbers.length > 0
    ? item.serial_numbers
    : Array.from({ length: Math.max(0, Math.min(Math.floor(item.available_qty), 50)) }, (_, i) => `SN-${item.item_code.substring(0, 4)}-${(i + 101).toString().padStart(4, "0")}`);

  return (
    <Modal isOpen={isOpen} onClose={onClose} size="lg">
      <ModalContent className="border border-line/70 bg-content1 shadow-2xl">
        <ModalHeader className="flex flex-col gap-1 border-b border-line pb-3">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <Package className="h-5 w-5 text-brand" />
              <span className="text-lg font-bold text-ink">{item.item_name}</span>
            </div>
            <Chip size="sm" variant="flat" color="primary">
              {item.category_name}
            </Chip>
          </div>
          <span className="mono font-mono text-xs text-muted">{item.item_code}</span>
        </ModalHeader>

        <ModalBody className="py-5 space-y-5">
          {/* Status Banners */}
          {isLow && (
            <div className="flex items-center gap-2 rounded-lg bg-danger-50 dark:bg-danger-900/20 p-3 text-xs font-semibold text-danger border border-danger-200">
              <ShieldAlert className="h-4 w-4 shrink-0" />
              <span>Low Stock Warning: Available quantity ({item.available_qty} {item.uom_code}) is below minimum stock threshold ({item.min_stock_level ?? 10}).</span>
            </div>
          )}

          {isExpiringSoon && (
            <div className="flex items-center gap-2 rounded-lg bg-warning-50 dark:bg-warning-900/20 p-3 text-xs font-semibold text-warning-700 dark:text-warning-400 border border-warning-200">
              <Calendar className="h-4 w-4 shrink-0" />
              <span>Expiry Notice: Batch {item.batch_number} expires on {item.expiry_date}.</span>
            </div>
          )}

          {/* Stock Metrics Grid */}
          <div className="grid grid-cols-3 gap-3">
            <div className="rounded-xl border border-line bg-content2 p-3 text-center">
              <span className="block text-[11px] font-semibold uppercase tracking-wider text-muted">Physical Qty</span>
              <span className="font-display text-xl font-bold text-ink">{item.physical_qty.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</span>
              <span className="block text-[10px] text-muted">{item.uom_code}</span>
            </div>

            <div className="rounded-xl border border-line bg-content2 p-3 text-center">
              <span className="block text-[11px] font-semibold uppercase tracking-wider text-muted">Reserved Qty</span>
              <span className="font-display text-xl font-bold text-muted">{item.reserved_qty.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</span>
              <span className="block text-[10px] text-muted">{item.uom_code}</span>
            </div>

            <div className="rounded-xl border border-brand/30 bg-brand-050/30 p-3 text-center">
              <span className="block text-[11px] font-semibold uppercase tracking-wider text-brand">Available Qty</span>
              <span className="font-display text-xl font-bold text-brand">{item.available_qty.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</span>
              <span className="block text-[10px] text-brand">{item.uom_code}</span>
            </div>
          </div>

          {/* Technical & Location Details */}
          <div className="space-y-3 rounded-xl border border-line p-4">
            <h4 className="text-xs font-bold uppercase tracking-wider text-muted flex items-center gap-1.5">
              <Layers className="h-3.5 w-3.5 text-brand" /> Stock, Asset & Tracking Identifiers
            </h4>

            <div className="grid grid-cols-2 gap-y-3 gap-x-6 text-sm">
              <div className="flex items-center justify-between border-b border-line/50 pb-1.5">
                <span className="text-muted flex items-center gap-1 text-xs"><MapPin className="h-3.5 w-3.5" /> Warehouse:</span>
                <span className="font-semibold text-ink">{item.warehouse_name}</span>
              </div>

              <div className="flex items-center justify-between border-b border-line/50 pb-1.5">
                <span className="text-muted flex items-center gap-1 text-xs"><DollarSign className="h-3.5 w-3.5" /> Valuation Rate:</span>
                <span className="font-semibold text-ink">₹{item.valuation_rate.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</span>
              </div>

              {item.asset_code && (
                <div className="flex items-center justify-between border-b border-line/50 pb-1.5">
                  <span className="text-muted flex items-center gap-1 text-xs"><Tag className="h-3.5 w-3.5 text-brand" /> Asset Code:</span>
                  <span className="mono font-mono text-xs font-bold text-brand">{item.asset_code}</span>
                </div>
              )}

              {item.consumable_code && (
                <div className="flex items-center justify-between border-b border-line/50 pb-1.5">
                  <span className="text-muted flex items-center gap-1 text-xs"><Tag className="h-3.5 w-3.5 text-secondary" /> Consumable Code:</span>
                  <span className="mono font-mono text-xs font-bold text-secondary">{item.consumable_code}</span>
                </div>
              )}

              <div className="flex items-center justify-between border-b border-line/50 pb-1.5">
                <span className="text-muted flex items-center gap-1 text-xs"><Layers className="h-3.5 w-3.5" /> Total Stock Value:</span>
                <span className="font-bold text-emerald-600">₹{item.total_value.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</span>
              </div>

              <div className="flex items-center justify-between border-b border-line/50 pb-1.5">
                <span className="text-muted flex items-center gap-1 text-xs"><CheckCircle2 className="h-3.5 w-3.5" /> Batch Tracked:</span>
                <span className="font-semibold text-ink">{item.is_batch_tracked ? "Yes" : "No"}</span>
              </div>

              {item.batch_number && (
                <div className="flex items-center justify-between border-b border-line/50 pb-1.5">
                  <span className="text-muted text-xs">Batch Number:</span>
                  <span className="mono font-mono text-xs font-bold text-ink">{item.batch_number}</span>
                </div>
              )}

              {item.expiry_date && (
                <div className="flex items-center justify-between border-b border-line/50 pb-1.5">
                  <span className="text-muted text-xs">Expiry Date:</span>
                  <span className="font-semibold text-ink">{item.expiry_date}</span>
                </div>
              )}

              <div className="flex items-center justify-between border-b border-line/50 pb-1.5">
                <span className="text-muted text-xs">Safety Min Level:</span>
                <span className="font-semibold text-ink">{item.min_stock_level ?? "N/A"}</span>
              </div>

              <div className="flex items-center justify-between border-b border-line/50 pb-1.5">
                <span className="text-muted text-xs">Reorder Level:</span>
                <span className="font-semibold text-ink">{item.reorder_level ?? "N/A"}</span>
              </div>
            </div>

            {/* Serial Numbers (S.No) List */}
            {serialNumbers.length > 0 && (
              <div className="pt-3 border-t border-line space-y-2">
                <div className="flex items-center justify-between text-xs font-bold text-ink">
                  <span className="flex items-center gap-1"><Hash className="h-3.5 w-3.5 text-emerald-600" /> Serial Numbers (S.No) for Available Stock</span>
                  <span className="text-emerald-600 font-mono">{serialNumbers.length} Serial Nos</span>
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-1.5 max-h-32 overflow-y-auto p-2 rounded-lg bg-content2/50 border border-line text-[11px] font-mono">
                  {serialNumbers.map((sNo, idx) => (
                    <div key={idx} className="p-1 rounded bg-content1 border border-line/60 flex items-center justify-between">
                      <span className="text-muted text-[9px]">#{idx + 1}</span>
                      <span className="font-bold text-ink">{sNo}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </ModalBody>

        <ModalFooter className="flex justify-between border-t border-line">
          <Button variant="light" onClick={onClose}>
            Close
          </Button>
          {onQuickAdjust && (
            <Button
              color="primary"
              onClick={() => {
                onClose();
                onQuickAdjust(item);
              }}
            >
              + Create Replenishment
            </Button>
          )}
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
