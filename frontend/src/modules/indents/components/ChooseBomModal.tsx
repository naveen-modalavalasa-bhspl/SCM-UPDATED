import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Modal, ModalBody, ModalContent, ModalFooter, ModalHeader, Skeleton,
} from "@heroui/react";

import { Button, Input } from "@/shared/components";
import type { Option } from "@/shared/types";
import {
  indentKeys, masterApi, type IndentAccountScope,
} from "../api";
import type { BomChoice, TemplateLineItem } from "../types";

interface PreviewItem extends TemplateLineItem {
  category_name?: string | null;
  isAvailable: boolean;
}

interface ChooseBomModalProps {
  isOpen: boolean;
  accountScope: IndentAccountScope;
  availableItems: Option[];
  itemCatalogError?: unknown;
  onClose: () => void;
  onUse: (items: TemplateLineItem[], unavailableCount: number) => void;
}

function includesSearch(value: string | null | undefined, search: string) {
  return (value ?? "").toLocaleLowerCase().includes(search.trim().toLocaleLowerCase());
}

function deduplicateItems(items: PreviewItem[]) {
  const seen = new Set<number>();
  return items.filter((item) => {
    if (seen.has(item.item_id)) return false;
    seen.add(item.item_id);
    return true;
  });
}

export function ChooseBomModal({
  isOpen,
  accountScope,
  availableItems,
  itemCatalogError,
  onClose,
  onUse,
}: ChooseBomModalProps) {
  const [search, setSearch] = useState("");
  const [selectedBomId, setSelectedBomId] = useState<number | null>(null);

  const boms = useQuery({
    queryKey: indentKeys.bomChoices(accountScope),
    queryFn: masterApi.boms,
    enabled: isOpen,
  });
  const bomItems = useQuery({
    queryKey: indentKeys.bomChoiceItems(accountScope, selectedBomId ?? 0),
    queryFn: () => masterApi.bomItems(selectedBomId!),
    enabled: isOpen && selectedBomId !== null,
  });

  const itemById = useMemo(
    () => new Map(availableItems.map((item) => [item.id, item])),
    [availableItems],
  );
  const filteredBoms = (boms.data ?? []).filter((bom) =>
    includesSearch(bom.name, search) || includesSearch(bom.code, search));
  const selectedBom = (boms.data ?? []).find((bom) => bom.id === selectedBomId);
  const preview = useMemo<PreviewItem[]>(() => {
    if (selectedBomId === null) return [];
    return deduplicateItems((bomItems.data ?? []).map((line) => {
      const activeItem = itemById.get(line.item_id);
      return {
        item_id: line.item_id,
        item_code: activeItem?.code ?? line.item_code ?? "—",
        item_name: activeItem?.name ?? line.item_name ?? "—",
        uom_code: activeItem?.uom_code ?? line.uom_code,
        category_name: line.category_name,
        quantity: line.quantity,
        isAvailable: Boolean(activeItem),
      };
    }));
  }, [bomItems.data, itemById, selectedBomId]);

  const close = () => {
    setSearch("");
    setSelectedBomId(null);
    onClose();
  };
  const loadError = itemCatalogError ?? boms.error;
  const availablePreview = preview.filter((item) => item.isAvailable);
  const unavailableCount = preview.length - availablePreview.length;

  return (
    <Modal
      isOpen={isOpen}
      onOpenChange={(open) => {
        if (!open) close();
      }}
      placement="center"
      scrollBehavior="inside"
      size="4xl"
    >
      <ModalContent>
        {() => (
          <>
            <ModalHeader className="flex-col items-start gap-1">
              <h2>Choose BOM</h2>
              <span className="text-sm font-normal text-muted">
                Select a saved BOM and adjust before creating.
              </span>
            </ModalHeader>
            <ModalBody>
              <Input
                aria-label="Search BOMs"
                placeholder="Search BOMs by name"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />

              {loadError ? (
                <div className="rounded-xl bg-bad-bg p-4 text-sm font-medium text-bad">
                  We couldn’t load BOMs. Please try again.
                </div>
              ) : boms.isLoading ? (
                <div className="grid gap-3 sm:grid-cols-2">
                  {[0, 1, 2, 3].map((row) => (
                    <Skeleton key={row} className="h-24 rounded-xl" />
                  ))}
                </div>
              ) : (
                <div className="grid max-h-56 gap-2 overflow-y-auto sm:grid-cols-2">
                  {filteredBoms.map((bom: BomChoice) => (
                    <button
                      key={bom.id}
                      type="button"
                      aria-pressed={selectedBomId === bom.id}
                      className={`min-h-20 rounded-xl border p-3 text-left transition ${
                        selectedBomId === bom.id
                          ? "border-brand bg-brand/5"
                          : "border-line bg-content1 hover:border-brand/50"
                      }`}
                      onClick={() => setSelectedBomId(bom.id)}
                    >
                      <span className="block font-semibold text-ink">{bom.name}</span>
                      <span className="mt-1 block text-xs text-muted">
                        {bom.total_items} {bom.total_items === 1 ? "item" : "items"}
                        {bom.project_name ? ` · ${bom.project_name}` : ""}
                        {` · ${bom.is_active ? "Active" : "Inactive"}`}
                      </span>
                      {bom.description && (
                        <span className="mt-1 line-clamp-1 block text-xs text-body">
                          {bom.description}
                        </span>
                      )}
                    </button>
                  ))}
                  {filteredBoms.length === 0 && (
                    <p className="col-span-full py-8 text-center text-sm text-muted">No BOM found.</p>
                  )}
                </div>
              )}

              {selectedBomId !== null && (
                <section aria-label="Included items" className="space-y-2">
                  <div className="flex items-center justify-between gap-3">
                    <h3 className="text-sm font-semibold text-ink">
                      Included items{selectedBom?.name ? ` · ${selectedBom.name}` : ""}
                    </h3>
                    <span className="text-xs text-muted">{preview.length} items</span>
                  </div>
                  {bomItems.error ? (
                    <div className="rounded-xl bg-bad-bg p-4 text-sm font-medium text-bad">
                      We couldn’t load the items in this BOM. Please try again.
                    </div>
                  ) : bomItems.isLoading ? (
                    <Skeleton className="h-32 rounded-xl" />
                  ) : (
                    <div className="max-h-64 overflow-auto rounded-xl border border-line">
                      <table className="w-full min-w-[560px] text-left text-sm">
                        <thead className="sticky top-0 bg-content2 text-xs text-muted">
                          <tr>
                            <th className="p-3">Item code</th>
                            <th className="p-3">Item name</th>
                            <th className="p-3">UOM</th>
                            <th className="p-3">Default quantity</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-line">
                          {preview.map((item) => (
                            <tr key={item.item_id}>
                              <td className="p-3 font-mono text-xs text-ink">{item.item_code}</td>
                              <td className="p-3">
                                <span className="font-medium text-ink">{item.item_name}</span>
                                {item.category_name && (
                                  <span className="block text-xs text-muted">{item.category_name}</span>
                                )}
                                {!item.isAvailable && (
                                  <span className="block text-xs font-medium text-bad">Unavailable</span>
                                )}
                              </td>
                              <td className="p-3 text-body">{item.uom_code || "—"}</td>
                              <td className="p-3 text-body">
                                {item.quantity != null && Number(item.quantity) > 0
                                  ? item.quantity
                                  : "—"}
                              </td>
                            </tr>
                          ))}
                          {preview.length === 0 && (
                            <tr>
                              <td colSpan={4} className="p-6 text-center text-sm text-muted">
                                No items found in this BOM.
                              </td>
                            </tr>
                          )}
                        </tbody>
                      </table>
                    </div>
                  )}
                  {unavailableCount > 0 && (
                    <p className="text-xs font-medium text-warn">
                      {unavailableCount} unavailable {unavailableCount === 1 ? "item" : "items"} will be skipped.
                    </p>
                  )}
                </section>
              )}
            </ModalBody>
            <ModalFooter>
              <Button variant="ghost" onClick={close}>Cancel</Button>
              <Button
                disabled={
                  selectedBomId === null
                  || availablePreview.length === 0
                  || bomItems.isLoading
                }
                onClick={() => {
                  onUse(
                    availablePreview.map(({ isAvailable: _isAvailable, category_name: _category, ...item }) => item),
                    unavailableCount,
                  );
                  close();
                }}
              >
                Use this BOM
              </Button>
            </ModalFooter>
          </>
        )}
      </ModalContent>
    </Modal>
  );
}
