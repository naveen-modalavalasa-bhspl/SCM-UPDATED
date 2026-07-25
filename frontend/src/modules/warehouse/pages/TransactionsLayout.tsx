// @ts-nocheck
import React from "react";
import { Outlet, useNavigate, useLocation, Navigate } from "react-router-dom";
import { Tabs, Tab } from "@heroui/react";
import { MenuIcon } from "@/shared/layout/icons";

export function TransactionsLayout() {
  const navigate = useNavigate();
  const location = useLocation();
  const currentPath = location.pathname;

  // Define the sub-transaction tabs
  const transactionTabs = [
    { key: "material-inward", name: "Material Inward", icon: "truck" },
    { key: "grn", name: "Goods Receipt (GRN)", icon: "file-text" },
    { key: "quality-inspection", name: "Quality Inspection", icon: "check-circle" },
    { key: "putaway", name: "Putaway", icon: "package" },
    { key: "purchase-returns", name: "Purchase Returns", icon: "file-text" },
    { key: "material-issues", name: "Material Issues", icon: "send" },
  ];

  // Resolve the active tab based on the current URL sub-path
  const activeTab = transactionTabs.find(t => currentPath.includes(`/transactions/${t.key}`))?.key || "material-inward";

  const handleTabChange = (key: string) => {
    navigate(`/warehouse/transactions/${key}`);
  };

  return (
    <div className="space-y-6">
      <div className="border-b border-line pb-1">
        <Tabs
          aria-label="Transaction sections"
          variant="underlined"
          color="primary"
          selectedKey={activeTab}
          onSelectionChange={(k) => handleTabChange(String(k))}
          classNames={{ tabList: "gap-4", cursor: "bg-brand", tab: "px-1 h-10" }}
        >
          {transactionTabs.map((t) => (
            <Tab
              key={t.key}
              title={
                <span className="flex items-center gap-1.5 text-xs font-semibold text-muted hover:text-ink">
                  <MenuIcon name={t.icon} className="h-3.5 w-3.5 text-current" />
                  {t.name}
                </span>
              }
            />
          ))}
        </Tabs>
      </div>
      <div className="pt-1">
        <Outlet />
      </div>
    </div>
  );
}

export default TransactionsLayout;
