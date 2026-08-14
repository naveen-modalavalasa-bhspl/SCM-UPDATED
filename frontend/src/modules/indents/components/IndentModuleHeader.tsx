import type { ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { Plus } from "lucide-react";
import { PageHeader, Button, Can } from "@/shared/components";
import { IndentFilterBar } from "./IndentFilterBar";

type FilterMode = "indents" | "activity" | "notifications";

interface IndentModuleHeaderProps {
  title?: string;
  /** Approvals reuses this header but is its own module — do not label it INDENT. */
  eyebrow?: string;
  showCreate?: boolean;
  /** Header-level actions for screens that do not raise indents (e.g. Mark all read). */
  actions?: ReactNode;
  /** Sits between the title and the filter bar — the module's tab strip. */
  subNav?: ReactNode;
  showFilters?: boolean;
  filterMode?: FilterMode;
  statusFilterOptions?: { value: string; label: string }[];
  statusFilterLabel?: string;
  singleStatusSelection?: boolean;
  separateDateFilters?: boolean;
  showRequiredBy?: boolean;
  showDate?: boolean;
  showStatus?: boolean;
  showPriority?: boolean;
  showRegion?: boolean;
  showTransaction?: boolean;
  showMovement?: boolean;
  showItem?: boolean;
  searchPlaceholder?: string;
}

export function IndentModuleHeader({
  title = "Indent",
  eyebrow = "INDENT",
  showCreate = true,
  actions,
  subNav,
  showFilters = true,
  filterMode = "indents",
  statusFilterOptions,
  statusFilterLabel,
  singleStatusSelection,
  separateDateFilters,
  showRequiredBy,
  showDate,
  showStatus,
  showPriority,
  showRegion,
  showTransaction,
  showMovement,
  showItem,
  searchPlaceholder,
}: IndentModuleHeaderProps) {
  const nav = useNavigate();

  return (
    <div className="mb-5">
      <PageHeader
        eyebrow={eyebrow}
        title={title}
        actions={
          showCreate ? (
            <Can do="indent.create">
              <Button onClick={() => nav("/indents/new")}>
                <Plus className="h-4 w-4" /> New indent
              </Button>
            </Can>
          ) : actions
        }
      />
      {subNav}
      {showFilters && (
        <IndentFilterBar
          mode={filterMode}
          statusFilterOptions={statusFilterOptions}
          statusFilterLabel={statusFilterLabel}
          singleStatusSelection={singleStatusSelection}
          separateDateFilters={separateDateFilters}
          showRequiredBy={showRequiredBy}
          showDate={showDate}
          showStatus={showStatus}
          showPriority={showPriority}
          showRegion={showRegion}
          showTransaction={showTransaction}
          showMovement={showMovement}
          showItem={showItem}
          searchPlaceholder={searchPlaceholder}
        />
      )}
    </div>
  );
}
