import { useState } from "react";
import { Boxes, History, RefreshCw, Truck } from "lucide-react";
import { PageHeader, SubNav, type SubNavItem } from "@/shared/components";
import { StockBalanceView } from "../components/StockBalanceView";
import { StockLedgerView } from "../components/StockLedgerView";
import { StockReplenishmentView } from "../components/StockReplenishmentView";
import { StockTransferView } from "../components/StockTransferView";

// These switch a view rather than a route, so the shared strip runs in state mode.
const screens: SubNavItem[] = [
  { key: "balance", label: "Stock balance", icon: Boxes },
  { key: "ledger", label: "Stock ledger", icon: History },
  { key: "replenishment", label: "Replenishment", icon: RefreshCw },
  { key: "transfer", label: "Transfers", icon: Truck },
];

export function InventoryTransactionsPage() {
  const [activeTab, setActiveTab] = useState("balance");

  return (
    <div className="space-y-6 pb-12">
      <PageHeader
        eyebrow="Core Inventory Module"
        title="Inventory Transactions & Management"
      />

      <SubNav
        label="Inventory"
        items={screens}
        value={activeTab}
        onChange={setActiveTab}
      />

      <div>
        {activeTab === "balance" && <StockBalanceView />}
        {activeTab === "ledger" && <StockLedgerView />}
        {activeTab === "replenishment" && <StockReplenishmentView />}
        {activeTab === "transfer" && <StockTransferView />}
      </div>
    </div>
  );
}
