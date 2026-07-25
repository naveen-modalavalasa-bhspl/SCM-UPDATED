import { Modal, ModalContent, ModalHeader, ModalBody, ModalFooter, Button } from "@heroui/react";
import { Barcode, Printer, X } from "lucide-react";
import type { StockBalanceItem } from "../types";

interface Props {
  isOpen: boolean;
  onClose: () => void;
  item: StockBalanceItem | null;
}

export function BarcodeModal({ isOpen, onClose, item }: Props) {
  if (!item) return null;

  const handlePrint = () => {
    window.print();
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} size="md">
      <ModalContent className="border border-line/70 bg-content1 shadow-xl">
        <ModalHeader className="flex items-center gap-2 text-ink">
          <Barcode className="h-5 w-5 text-brand" />
          <span>Barcode Label - {item.item_code}</span>
        </ModalHeader>

        <ModalBody className="py-6">
          <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-line bg-content2 p-6 text-center space-y-4">
            <div className="text-xs font-semibold uppercase tracking-widest text-muted">
              {item.warehouse_name}
            </div>

            <div className="font-bold text-lg text-ink">{item.item_name}</div>

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
              *{item.item_code}*
            </div>

            <div className="grid grid-cols-2 gap-4 text-xs text-muted w-full pt-2 border-t border-line">
              <div>
                <span className="block font-medium">Batch No:</span>
                <span className="font-mono text-ink">{item.batch_number || "N/A"}</span>
              </div>
              <div>
                <span className="block font-medium">UOM:</span>
                <span className="font-mono text-ink">{item.uom_code}</span>
              </div>
            </div>
          </div>
        </ModalBody>

        <ModalFooter className="flex justify-between border-t border-line">
          <Button variant="light" onClick={onClose}>
            <X className="h-4 w-4 mr-1" /> Close
          </Button>
          <Button color="primary" onClick={handlePrint}>
            <Printer className="h-4 w-4 mr-1" /> Print Label
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
