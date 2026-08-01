import { createContext, useCallback, useContext, useState, type ReactNode } from "react";

export type DatePreset = "all" | "today" | "this_week" | "this_month" | "custom";
export type RequiredByPreset = "any" | "today" | "next_7_days" | "next_30_days" | "custom";

export interface FilterState {
  search: string;
  datePreset: DatePreset;
  startDate: string;
  endDate: string;
  requiredByFrom: string;
  requiredByTo: string;
  requiredByPreset: RequiredByPreset;
  selectedStatuses: string[];
  selectedPriorities: string[];
  selectedDepartments: number[];
  selectedProjects: number[];
  selectedWarehouses: number[];
  selectedItems: number[];
  selectedCreatedBy: number[];
  transactionType: string;
  direction: string;
  itemId: string;
  sortBy: string;
  sortDir: string;
  page: number;
}

export interface IndentFilterContextType {
  search: string;
  setSearch: (val: string) => void;
  datePreset: DatePreset;
  setDatePreset: (preset: DatePreset) => void;
  startDate: string;
  setStartDate: (val: string) => void;
  endDate: string;
  setEndDate: (val: string) => void;
  requiredByFrom: string;
  setRequiredByFrom: (val: string) => void;
  requiredByTo: string;
  setRequiredByTo: (val: string) => void;
  requiredByPreset: RequiredByPreset;
  applyRaisedDate: (preset: DatePreset, from: string, to: string) => void;
  clearRaisedDate: () => void;
  applyRequiredByDate: (preset: RequiredByPreset, from: string, to: string) => void;
  clearRequiredByDate: () => void;

  selectedStatuses: string[];
  setSelectedStatuses: (val: string[]) => void;
  toggleStatus: (status: string) => void;

  selectedPriorities: string[];
  setSelectedPriorities: (val: string[]) => void;
  togglePriority: (priority: string) => void;

  selectedDepartments: number[];
  setSelectedDepartments: (val: number[]) => void;
  toggleDepartment: (id: number) => void;

  selectedProjects: number[];
  setSelectedProjects: (val: number[]) => void;
  toggleProject: (id: number) => void;

  selectedWarehouses: number[];
  setSelectedWarehouses: (val: number[]) => void;
  toggleWarehouse: (id: number) => void;

  selectedItems: number[];
  setSelectedItems: (val: number[]) => void;
  toggleItem: (id: number) => void;

  selectedCreatedBy: number[];
  setSelectedCreatedBy: (val: number[]) => void;
  toggleCreatedBy: (id: number) => void;

  transactionType: string;
  setTransactionType: (val: string) => void;
  direction: string;
  setDirection: (val: string) => void;
  itemId: string;
  setItemId: (val: string) => void;

  departmentId: number | null;
  setDepartmentId: (id: number | null) => void;

  sortBy: string;
  setSortBy: (val: string) => void;
  sortDir: string;
  setSortDir: (val: string) => void;
  page: number;
  setPage: (val: number) => void;

  resetFilters: () => void;
  activeFilterCount: number;
}

const IndentFilterContext = createContext<IndentFilterContextType | undefined>(undefined);

export function IndentFilterValueProvider({
  children,
  value,
}: {
  children: ReactNode;
  value: IndentFilterContextType;
}) {
  return (
    <IndentFilterContext.Provider value={value}>
      {children}
    </IndentFilterContext.Provider>
  );
}

function getPresetDates(preset: DatePreset): { startDate: string; endDate: string } {
  const now = new Date();
  const fmt = (d: Date) => {
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  };

  if (preset === "today") {
    const today = fmt(now);
    return { startDate: today, endDate: today };
  } else if (preset === "this_week") {
    const first = new Date(now);
    const day = now.getDay();
    const diff = now.getDate() - day + (day === 0 ? -6 : 1); // Monday
    first.setDate(diff);
    return { startDate: fmt(first), endDate: fmt(now) };
  } else if (preset === "this_month") {
    const first = new Date(now.getFullYear(), now.getMonth(), 1);
    return { startDate: fmt(first), endDate: fmt(now) };
  }
  return { startDate: "", endDate: "" };
}

export function IndentFilterProvider({ children }: { children: ReactNode }) {
  const [search, setSearch] = useState("");
  const [datePreset, setDatePresetState] = useState<DatePreset>("all");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [requiredByFrom, setRequiredByFrom] = useState("");
  const [requiredByTo, setRequiredByTo] = useState("");
  const [requiredByPreset, setRequiredByPreset] = useState<RequiredByPreset>("any");

  const [selectedStatuses, setSelectedStatuses] = useState<string[]>([]);
  const [selectedPriorities, setSelectedPriorities] = useState<string[]>([]);
  const [selectedDepartments, setSelectedDepartments] = useState<number[]>([]);
  const [selectedProjects, setSelectedProjects] = useState<number[]>([]);
  const [selectedWarehouses, setSelectedWarehouses] = useState<number[]>([]);
  const [selectedItems, setSelectedItems] = useState<number[]>([]);
  const [selectedCreatedBy, setSelectedCreatedBy] = useState<number[]>([]);
  const [transactionType, setTransactionTypeState] = useState("");
  const [direction, setDirectionState] = useState("");
  const [itemId, setItemIdState] = useState("");
  const [departmentId, setDepartmentIdState] = useState<number | null>(null);

  const [sortBy, setSortBy] = useState("created_at");
  const [sortDir, setSortDir] = useState("desc");
  const [page, setPage] = useState(1);

  const resetPage = useCallback(() => setPage(1), []);

  const setSearchAndReset = useCallback((val: string) => {
    const nextSearch = val.trim();
    if (nextSearch === search) return;
    setSearch(nextSearch);
    resetPage();
  }, [resetPage, search]);

  const setDepartmentId = (id: number | null) => {
    setDepartmentIdState(id);
    if (id !== null) {
      setSelectedDepartments([id]);
    } else {
      setSelectedDepartments([]);
    }
    resetPage();
  };

  const setDatePreset = (preset: DatePreset) => {
    if (preset === "all" || preset === datePreset) {
      setDatePresetState("all");
      setStartDate("");
      setEndDate("");
      resetPage();
      return;
    }

    setDatePresetState(preset);
    if (preset === "custom") {
      setStartDate("");
      setEndDate("");
    } else {
      const { startDate: nextStart, endDate: nextEnd } = getPresetDates(preset);
      setStartDate(nextStart);
      setEndDate(nextEnd);
    }
    resetPage();
  };

  const toggleStatus = (status: string) => {
    setSelectedStatuses((prev) =>
      prev.includes(status) ? prev.filter((s) => s !== status) : [...prev, status]
    );
    resetPage();
  };

  const togglePriority = (priority: string) => {
    setSelectedPriorities((prev) =>
      prev.includes(priority) ? prev.filter((p) => p !== priority) : [...prev, priority]
    );
    resetPage();
  };

  const toggleDepartment = (id: number) => {
    setSelectedDepartments((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    );
    resetPage();
  };

  const toggleProject = (id: number) => {
    setSelectedProjects((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    );
    resetPage();
  };

  const toggleWarehouse = (id: number) => {
    setSelectedWarehouses((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    );
    resetPage();
  };

  const toggleItem = (id: number) => {
    setSelectedItems((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    );
    resetPage();
  };

  const toggleCreatedBy = (id: number) => {
    setSelectedCreatedBy((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    );
    resetPage();
  };

  const setStartDateAndReset = (val: string) => {
    setStartDate(val);
    resetPage();
  };

  const setEndDateAndReset = (val: string) => {
    setEndDate(val);
    resetPage();
  };

  const setRequiredByFromAndReset = (val: string) => {
    setRequiredByFrom(val);
    resetPage();
  };

  const setRequiredByToAndReset = (val: string) => {
    setRequiredByTo(val);
    resetPage();
  };

  const applyRaisedDate = useCallback((preset: DatePreset, from: string, to: string) => {
    setDatePresetState(preset);
    setStartDate(from);
    setEndDate(to);
    resetPage();
  }, [resetPage]);

  const clearRaisedDate = useCallback(() => {
    setDatePresetState("all");
    setStartDate("");
    setEndDate("");
    resetPage();
  }, [resetPage]);

  const applyRequiredByDate = useCallback((
    preset: RequiredByPreset,
    from: string,
    to: string,
  ) => {
    setRequiredByPreset(preset);
    setRequiredByFrom(from);
    setRequiredByTo(to);
    resetPage();
  }, [resetPage]);

  const clearRequiredByDate = useCallback(() => {
    setRequiredByPreset("any");
    setRequiredByFrom("");
    setRequiredByTo("");
    resetPage();
  }, [resetPage]);

  const setSelectedStatusesAndReset = useCallback((val: string[]) => {
    setSelectedStatuses(val);
    resetPage();
  }, [resetPage]);

  const setSelectedPrioritiesAndReset = (val: string[]) => {
    setSelectedPriorities(val);
    resetPage();
  };

  const setTransactionType = (val: string) => {
    setTransactionTypeState(val);
    resetPage();
  };

  const setDirection = (val: string) => {
    setDirectionState(val);
    resetPage();
  };

  const setItemId = (val: string) => {
    setItemIdState(val.trim());
    resetPage();
  };

  const resetFilters = () => {
    setSearch("");
    setDatePresetState("all");
    setStartDate("");
    setEndDate("");
    setRequiredByFrom("");
    setRequiredByTo("");
    setRequiredByPreset("any");
    setSelectedStatuses([]);
    setSelectedPriorities([]);
    setSelectedDepartments([]);
    setSelectedProjects([]);
    setSelectedWarehouses([]);
    setSelectedItems([]);
    setSelectedCreatedBy([]);
    setTransactionTypeState("");
    setDirectionState("");
    setItemIdState("");
    setDepartmentIdState(null);
    setSortBy("created_at");
    setSortDir("desc");
    setPage(1);
  };

  const activeFilterCount =
    (search.trim() ? 1 : 0) +
    (datePreset !== "all" || startDate || endDate ? 1 : 0) +
    (requiredByPreset !== "any" || requiredByFrom || requiredByTo ? 1 : 0) +
    selectedStatuses.length +
    selectedPriorities.length +
    selectedDepartments.length +
    selectedProjects.length +
    selectedWarehouses.length +
    selectedItems.length +
    selectedCreatedBy.length +
    (transactionType ? 1 : 0) +
    (direction ? 1 : 0) +
    (itemId ? 1 : 0);

  return (
    <IndentFilterContext.Provider
      value={{
        search,
        setSearch: setSearchAndReset,
        datePreset,
        setDatePreset,
        startDate,
        setStartDate: setStartDateAndReset,
        endDate,
        setEndDate: setEndDateAndReset,
        requiredByFrom,
        setRequiredByFrom: setRequiredByFromAndReset,
        requiredByTo,
        setRequiredByTo: setRequiredByToAndReset,
        requiredByPreset,
        applyRaisedDate,
        clearRaisedDate,
        applyRequiredByDate,
        clearRequiredByDate,
        selectedStatuses,
        setSelectedStatuses: setSelectedStatusesAndReset,
        toggleStatus,
        selectedPriorities,
        setSelectedPriorities: setSelectedPrioritiesAndReset,
        togglePriority,
        selectedDepartments,
        setSelectedDepartments,
        toggleDepartment,
        selectedProjects,
        setSelectedProjects,
        toggleProject,
        selectedWarehouses,
        setSelectedWarehouses,
        toggleWarehouse,
        selectedItems,
        setSelectedItems,
        toggleItem,
        selectedCreatedBy,
        setSelectedCreatedBy,
        toggleCreatedBy,
        transactionType,
        setTransactionType,
        direction,
        setDirection,
        itemId,
        setItemId,
        departmentId,
        setDepartmentId,
        sortBy,
        setSortBy,
        sortDir,
        setSortDir,
        page,
        setPage,
        resetFilters,
        activeFilterCount,
      }}
    >
      {children}
    </IndentFilterContext.Provider>
  );
}

export function useIndentFilters() {
  const context = useContext(IndentFilterContext);
  if (!context) {
    throw new Error("useIndentFilters must be used within an IndentFilterProvider");
  }
  return context;
}
