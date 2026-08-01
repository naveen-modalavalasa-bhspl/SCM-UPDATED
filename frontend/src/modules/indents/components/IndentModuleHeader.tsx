import { useNavigate } from "react-router-dom";
import { Plus } from "lucide-react";
import { PageHeader, Button, Can } from "@/shared/components";
import { IndentFilterBar } from "./IndentFilterBar";

type FilterMode = "indents" | "acknowledgments" | "activity" | "notifications";

interface IndentModuleHeaderProps {
  title?: string;
  /** Approvals reuses this header but is its own module — do not label it INDENT. */
  eyebrow?: string;
  showCreate?: boolean;
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
  showTransaction?: boolean;
  showMovement?: boolean;
  showItem?: boolean;
  searchPlaceholder?: string;
}

export function IndentModuleHeader({
  title = "Indent",
  eyebrow = "INDENT",
  showCreate = true,
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
          ) : undefined
        }
      />
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
          showTransaction={showTransaction}
          showMovement={showMovement}
          showItem={showItem}
          searchPlaceholder={searchPlaceholder}
        />
      )}
    </div>
  );
}
