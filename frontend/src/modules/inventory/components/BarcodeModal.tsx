import { useState } from "react";
import { Modal, ModalContent, ModalHeader, ModalBody, ModalFooter, Button, Input } from "@heroui/react";
import { Barcode, Printer, X, Search, MapPin, Box } from "lucide-react";
import type { StockBalanceItem } from "../types";
import { getItemAvailability } from "../api";

interface Props {
  isOpen: boolean;
  onClose: () => void;
  item: StockBalanceItem | null;
}

export function BarcodeModal({ isOpen, onClose, item }: Props) {
  const [scanQuery, setScanQuery] = useState("");
  const [locateResult, setLocateResult] = useState<any>(null);
  const [searching, setSearching] = useState(false);

  const handleScanLocate = async () => {
    if (!scanQuery.trim()) return;
    setSearching(true);
    try {
      const itemId = parseInt(scanQuery.trim()) || 1;
      const data = await getItemAvailability(itemId);
      setLocateResult(data);
    } catch (e) {
      console.error(e);
    } finally {
      setSearching(false);
    }
  };

  const handlePrint = () => {
    window.print();
  };

  const displayItem = item;

  return (
    <Modal isOpen={isOpen} onClose={onClose} size="lg">
      <ModalContent className="border border-line/70 bg-content1 shadow-xl">
        <ModalHeader className="flex items-center gap-2 text-ink">
          <Barcode className="h-5 w-5 text-brand" />
          <span>Barcode Scanner & Stock Locator</span>
        </ModalHeader>

        <ModalBody className="py-4 space-y-4">
          {/* Scan & Locate Input */}
          <div className="flex gap-2">
            <Input
              placeholder="Scan barcode or enter Item ID / Code..."
              value={scanQuery}
              onChange={(e) => setScanQuery(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleScanLocate()}
              startContent={<Search className="h-4 w-4 text-muted" />}
              className="flex-1"
            />
            <Button color="primary" onClick={handleScanLocate} isLoading={searching}>
              Locate Item
            </Button>
          </div>

          {/* Locate Result */}
          {locateResult && (
            <div className="rounded-xl border border-line bg-content2 p-4 space-y-2">
              <div className="flex items-center gap-2 font-bold text-ink text-sm">
                <MapPin className="h-4 w-4 text-brand" />
                <span>Live Location for Item #{locateResult.item_id} ({locateResult.item_code})</span>
              </div>
              <div className="text-xs text-muted">
                Total Available: <strong>{locateResult.total_available_qty}</strong> {locateResult.uom_code} | Strategy: <strong>{locateResult.pick_strategy}</strong>
              </div>
              {locateResult.batches && locateResult.batches.length > 0 ? (
                <div className="space-y-1 pt-2">
                  {locateResult.batches.map((b: any, idx: number) => (
                    <div key={idx} className="flex justify-between items-center text-xs p-2 rounded bg-content1 border border-line">
                      <span><Box className="inline h-3 w-3 mr-1 text-muted" />{b.warehouse_name || `Warehouse #${b.warehouse_id}`} (Bin: {b.bin_code || b.bin_id})</span>
                      <span className="font-mono font-bold text-brand">{b.available_qty} {locateResult.uom_code}</span>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="text-xs text-muted italic">No active batches located for this item.</div>
              )}
            </div>
          )}

          {/* Display Label for selected item */}
          {displayItem && (
            <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-line bg-content2 p-6 text-center space-y-4">
              <div className="text-xs font-semibold uppercase tracking-widest text-muted">
                {displayItem.warehouse_name}
              </div>

              <div className="font-bold text-lg text-ink">{displayItem.item_name}</div>

              {/* Synthetic barcode representation */}
              <div className="flex items-center justify-center gap-1 py-4 px-6 bg-white rounded border border-gray-200">
                {Array.from({ length: 32 }).map((_, i) => (
                  <div
                    key={i}
                    className="bg-black rounded-sm h-16"
                    style={{
                      width: i % 3 === 0 ? "4px" : i % 5 === 0 ? "1px" : "2px",
                      opacity: i % 7 === 0 ? 0.4 : 1,
                    }}
                  />
                ))}
              </div>

              <div className="mono font-mono text-sm font-bold tracking-widest text-ink bg-content1 px-3 py-1 rounded border border-line">
                *{displayItem.item_code}*
              </div>

              <div className="grid grid-cols-2 gap-4 text-xs text-muted w-full pt-2 border-t border-line">
                <div>
                  <span className="block font-medium">Batch No:</span>
                  <span className="font-mono text-ink">{displayItem.batch_number || "N/A"}</span>
                </div>
                <div>
                  <span className="block font-medium">UOM:</span>
                  <span className="font-mono text-ink">{displayItem.uom_code}</span>
                </div>
              </div>
            </div>
          )}
        </ModalBody>

        <ModalFooter className="flex justify-between border-t border-line">
          <Button variant="light" onClick={onClose}>
            <X className="h-4 w-4 mr-1" /> Close
          </Button>
          {displayItem && (
            <Button color="primary" onClick={handlePrint}>
              <Printer className="h-4 w-4 mr-1" /> Print Label
            </Button>
          )}
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}

