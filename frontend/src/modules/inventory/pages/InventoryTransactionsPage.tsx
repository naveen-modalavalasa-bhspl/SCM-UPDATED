import { useState } from "react";
import { Tab, Tabs } from "@heroui/react";
import { Boxes, History, RefreshCw, Truck } from "lucide-react";
import { PageHeader } from "@/shared/components";
import { StockBalanceView } from "../components/StockBalanceView";
import { StockLedgerView } from "../components/StockLedgerView";
import { StockReplenishmentView } from "../components/StockReplenishmentView";
import { StockTransferView } from "../components/StockTransferView";

export function InventoryTransactionsPage() {
  const [activeTab, setActiveTab] = useState("balance");

  return (
    <div className="space-y-6 pb-12">
      <PageHeader
        eyebrow="Core Inventory Module"
        title="Inventory Transactions & Management"
      />

      <Tabs
        aria-label="Inventory Transaction Screens"
        variant="bordered"
        color="primary"
        radius="full"
        selectedKey={activeTab}
        onSelectionChange={(key) => setActiveTab(String(key))}
        classNames={{
          base: "w-full overflow-x-auto pb-1",
          tabList: "bg-content1 p-1.5 border border-line shadow-xs rounded-2xl gap-2",
          tab: "min-h-11 px-5 text-sm font-semibold transition-all",
          tabContent: "group-data-[selected=true]:text-white font-bold flex items-center gap-2",
        }}
      >
        <Tab
          key="balance"
          title={
            <div className="flex items-center gap-2">
              <Boxes className="h-4 w-4" />
              <span>Stock Balance</span>
            </div>
          }
        />
        <Tab
          key="ledger"
          title={
            <div className="flex items-center gap-2">
              <History className="h-4 w-4" />
              <span>Stock Ledger</span>
            </div>
          }
        />
        <Tab
          key="replenishment"
          title={
            <div className="flex items-center gap-2">
              <RefreshCw className="h-4 w-4" />
              <span>Stock Replenishment</span>
            </div>
          }
        />
        <Tab
          key="transfer"
          title={
            <div className="flex items-center gap-2">
              <Truck className="h-4 w-4" />
              <span>Stock Transfer</span>
            </div>
          }
        />
      </Tabs>

      <div className="mt-4">
        {activeTab === "balance" && <StockBalanceView />}
        {activeTab === "ledger" && <StockLedgerView />}
        {activeTab === "replenishment" && <StockReplenishmentView />}
        {activeTab === "transfer" && <StockTransferView />}
      </div>
    </div>
  );
}
