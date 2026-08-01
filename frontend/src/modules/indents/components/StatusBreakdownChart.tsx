import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent, RefObject } from "react";
import {
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  Sector,
} from "recharts";
import type { SectorProps } from "recharts";

const PRIMARY_STATUSES = [
  { status: "PENDING_APPROVAL", label: "Pending approval" },
  { status: "AWAITING_ALLOCATION", label: "Awaiting allocation" },
  { status: "ALLOCATED", label: "Allocated" },
  { status: "REJECTED", label: "Rejected" },
  { status: "DRAFT", label: "Draft" },
] as const;
const TOOLTIP_OFFSET = 12;
const TOOLTIP_EDGE_PADDING = 8;
const TOOLTIP_FALLBACK_WIDTH = 160;
const TOOLTIP_FALLBACK_HEIGHT = 72;

export const STATUS_INDICATOR: Record<string, string> = {
  DRAFT: "bg-neutral",
  PENDING_APPROVAL: "bg-warn",
  SUBMITTED: "bg-warn",
  APPROVED: "bg-ok",
  AWAITING_ALLOCATION: "bg-info",
  ALLOCATED: "bg-ok",
  PARTIALLY_FULFILLED: "bg-info",
  PENDING_PROCUREMENT: "bg-purple-500",
  PARTIALLY_ORDERED: "bg-blue-600",
  ORDERED: "bg-blue-600",
  REJECTED: "bg-bad",
  CLOSED: "bg-neutral",
};

export const STATUS_COLOR: Record<string, string> = {
  DRAFT: "var(--color-neutral)",
  PENDING_APPROVAL: "var(--color-warn)",
  SUBMITTED: "var(--color-warn)",
  APPROVED: "var(--color-ok)",
  AWAITING_ALLOCATION: "var(--color-info)",
  ALLOCATED: "var(--color-ok)",
  PARTIALLY_FULFILLED: "var(--color-info)",
  PENDING_PROCUREMENT: "#8b5cf6",
  PARTIALLY_ORDERED: "#2563eb",
  ORDERED: "#2563eb",
  REJECTED: "var(--color-bad)",
  CLOSED: "var(--color-neutral)",
};

const DEFAULT_STATUS_COLOR = "var(--color-neutral)";

export interface StatusSlice {
  status: string;
  label: string;
  count: number;
  percentage: number;
  isSelectable: boolean;
}

type DonutSectorProps = SectorProps & {
  index?: number;
  payload?: StatusSlice;
};

export interface TooltipPosition {
  x: number;
  y: number;
}

export function getStatusTooltipPosition({
  pointerX,
  pointerY,
  containerWidth,
  containerHeight,
  tooltipWidth = TOOLTIP_FALLBACK_WIDTH,
  tooltipHeight = TOOLTIP_FALLBACK_HEIGHT,
}: {
  pointerX: number;
  pointerY: number;
  containerWidth: number;
  containerHeight: number;
  tooltipWidth?: number;
  tooltipHeight?: number;
}): TooltipPosition {
  const availableWidth = Math.max(0, containerWidth - TOOLTIP_EDGE_PADDING * 2);
  const availableHeight = Math.max(0, containerHeight - TOOLTIP_EDGE_PADDING * 2);
  const boundedWidth = Math.min(tooltipWidth, availableWidth);
  const boundedHeight = Math.min(tooltipHeight, availableHeight);
  const maxX = Math.max(TOOLTIP_EDGE_PADDING, containerWidth - boundedWidth - TOOLTIP_EDGE_PADDING);
  const maxY = Math.max(TOOLTIP_EDGE_PADDING, containerHeight - boundedHeight - TOOLTIP_EDGE_PADDING);
  const preferredX = pointerX + TOOLTIP_OFFSET + boundedWidth <= containerWidth - TOOLTIP_EDGE_PADDING
    ? pointerX + TOOLTIP_OFFSET
    : pointerX - TOOLTIP_OFFSET - boundedWidth;
  const preferredY = pointerY + TOOLTIP_OFFSET + boundedHeight <= containerHeight - TOOLTIP_EDGE_PADDING
    ? pointerY + TOOLTIP_OFFSET
    : pointerY - TOOLTIP_OFFSET - boundedHeight;

  return {
    x: Math.min(maxX, Math.max(TOOLTIP_EDGE_PADDING, preferredX)),
    y: Math.min(maxY, Math.max(TOOLTIP_EDGE_PADDING, preferredY)),
  };
}

function safeCount(count: number | undefined) {
  return Number.isFinite(count) && (count ?? 0) > 0 ? count! : 0;
}

export function buildStatusBreakdownData(byStatus: Record<string, number>) {
  const displayedCounts = PRIMARY_STATUSES.map(({ status, label }) => ({
    status,
    label,
    count: safeCount(byStatus[status]),
    isSelectable: true,
  }));
  const total = displayedCounts.reduce((sum, { count }) => sum + count, 0);
  const entries: StatusSlice[] = displayedCounts.map((entry) => ({
    ...entry,
    percentage: total > 0 ? Math.round((entry.count / total) * 100) : 0,
  }));

  return { entries, total };
}

function accessibleStatusLabel(entry: StatusSlice) {
  return `${entry.label}: ${entry.count} ${entry.count === 1 ? "indent" : "indents"}, ${entry.percentage} percent`;
}

function DonutSector({
  payload,
  fill = DEFAULT_STATUS_COLOR,
  isActive,
  isSelected,
  hasActiveStatus,
  hasSeparators,
  onActivate,
  onMove,
  onDeactivate,
  ...sectorProps
}: DonutSectorProps & {
  isActive: boolean;
  isSelected: boolean;
  hasActiveStatus: boolean;
  hasSeparators: boolean;
  onActivate: (event: ReactMouseEvent<SVGGElement>) => void;
  onMove: (event: ReactMouseEvent<SVGGElement>) => void;
  onDeactivate: () => void;
}) {
  if (!payload) return null;

  const stroke = hasSeparators ? "hsl(var(--heroui-content1))" : "none";
  const strokeWidth = hasSeparators ? 2 : 0;
  const middleAngle = (Number(sectorProps.startAngle) + Number(sectorProps.endAngle)) / 2;
  const middleRadius = (Number(sectorProps.innerRadius) + Number(sectorProps.outerRadius)) / 2;
  const anchorX = Number(sectorProps.cx) + middleRadius * Math.cos(-middleAngle * Math.PI / 180);
  const anchorY = Number(sectorProps.cy) + middleRadius * Math.sin(-middleAngle * Math.PI / 180);

  return (
    <g
      role="img"
      focusable="false"
      aria-label={accessibleStatusLabel(payload)}
      data-testid={`status-donut-slice-${payload.status}`}
      data-status={payload.status}
      data-color={fill}
      data-anchor-x={anchorX}
      data-anchor-y={anchorY}
      data-inner-radius={sectorProps.innerRadius}
      data-outer-radius={sectorProps.outerRadius}
      data-active={isActive ? "true" : "false"}
      data-selected={isSelected ? "true" : "false"}
      fill={fill}
      fillOpacity={hasActiveStatus && !isActive ? 0.45 : 1}
      className="outline-none transition-opacity duration-200"
      onMouseDown={(event) => event.preventDefault()}
      onMouseEnter={onActivate}
      onMouseMove={onMove}
      onMouseLeave={onDeactivate}
    >
      <Sector
        {...sectorProps}
        aria-hidden="true"
        focusable="false"
        fill={fill}
        fillOpacity={hasActiveStatus && !isActive ? 0.45 : 1}
        stroke={stroke}
        strokeWidth={strokeWidth}
      />
    </g>
  );
}

function DonutCentre({ total }: { total: number }) {
  return (
    <div
      data-testid="status-donut-total"
      aria-label={`${total} total ${total === 1 ? "indent" : "indents"}`}
      className="pointer-events-none absolute inset-0 z-10 flex flex-col items-center justify-center text-center"
    >
      <span className="text-3xl font-bold leading-none tabular-nums text-ink">{total}</span>
      <span className="mt-1 text-xs font-medium text-muted">Total indents</span>
    </div>
  );
}

function StatusTooltip({
  entry,
  position,
  tooltipRef,
}: {
  entry: StatusSlice;
  position: TooltipPosition;
  tooltipRef: RefObject<HTMLDivElement>;
}) {
  return (
    <div
      ref={tooltipRef}
      role="tooltip"
      data-tooltip-x={position.x}
      data-tooltip-y={position.y}
      style={{ left: position.x, top: position.y }}
      className="pointer-events-none absolute z-20 w-40 max-w-[calc(100%-1rem)] rounded-lg border border-line/80 bg-content1 px-3 py-2 text-left opacity-100 shadow-sm transition-opacity duration-100"
    >
      <p className="text-xs font-semibold leading-4 text-ink">{entry.label}</p>
      <p className="mt-1 text-xs font-medium tabular-nums text-body">
        {entry.count} {entry.count === 1 ? "indent" : "indents"}
      </p>
      <p className="text-[11px] tabular-nums text-muted">{entry.percentage}% of total</p>
    </div>
  );
}

export function StatusBreakdownChart({
  byStatus,
  selectedStatuses = [],
}: {
  byStatus: Record<string, number>;
  selectedStatuses?: string[];
}) {
  const { entries, total } = useMemo(
    () => buildStatusBreakdownData(byStatus),
    [byStatus],
  );
  const chartEntries = entries.filter(({ count }) => count > 0);
  const containerRef = useRef<HTMLDivElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const [hoveredSliceStatus, setHoveredSliceStatus] = useState<string | null>(null);
  const [tooltipPosition, setTooltipPosition] = useState<TooltipPosition | null>(null);
  const [hoveredRowStatus, setHoveredRowStatus] = useState<string | null>(null);
  const selectedStatusSet = useMemo(() => new Set(selectedStatuses), [selectedStatuses]);
  const tooltipEntry = entries.find(({ status }) => status === hoveredSliceStatus) ?? null;
  const highlightedSliceStatus = hoveredSliceStatus ?? hoveredRowStatus;
  const selectedStatusKey = useMemo(
    () => [...selectedStatuses].sort().join("|"),
    [selectedStatuses],
  );
  const breakdownKey = useMemo(
    () => entries.map(({ status, count }) => `${status}:${count}`).join("|"),
    [entries],
  );

  const hideTooltip = useCallback(() => {
    setHoveredSliceStatus(null);
    setTooltipPosition(null);
  }, []);

  const updateTooltip = useCallback((
    status: string,
    event: ReactMouseEvent<Element>,
  ) => {
    const bounds = containerRef.current?.getBoundingClientRect();
    if (!bounds) return;

    const measuredWidth = tooltipRef.current?.offsetWidth ?? TOOLTIP_FALLBACK_WIDTH;
    const measuredHeight = tooltipRef.current?.offsetHeight ?? TOOLTIP_FALLBACK_HEIGHT;
    const position = getStatusTooltipPosition({
      pointerX: event.clientX - bounds.left,
      pointerY: event.clientY - bounds.top,
      containerWidth: bounds.width,
      containerHeight: bounds.height,
      tooltipWidth: measuredWidth,
      tooltipHeight: measuredHeight,
    });
    setHoveredSliceStatus(status);
    setTooltipPosition(position);
  }, []);

  const showTooltipBySlice = useCallback((status: string) => {
    const container = containerRef.current;
    const slice = container?.querySelector<SVGGElement>(`[data-status="${status}"]`);
    if (!container || !slice) return;

    const containerBounds = container.getBoundingClientRect();
    const sliceBounds = slice.getBoundingClientRect();
    let anchorClientX = sliceBounds.left + sliceBounds.width / 2;
    let anchorClientY = sliceBounds.top + sliceBounds.height / 2;
    const anchorX = Number(slice.dataset.anchorX);
    const anchorY = Number(slice.dataset.anchorY);
    const matrix = slice.getScreenCTM();
    const svg = slice.ownerSVGElement;
    if (Number.isFinite(anchorX) && Number.isFinite(anchorY) && matrix && svg) {
      const anchor = svg.createSVGPoint();
      anchor.x = anchorX;
      anchor.y = anchorY;
      const screenAnchor = anchor.matrixTransform(matrix);
      anchorClientX = screenAnchor.x;
      anchorClientY = screenAnchor.y;
    }
    const measuredWidth = tooltipRef.current?.offsetWidth ?? TOOLTIP_FALLBACK_WIDTH;
    const measuredHeight = tooltipRef.current?.offsetHeight ?? TOOLTIP_FALLBACK_HEIGHT;
    const position = getStatusTooltipPosition({
      pointerX: anchorClientX - containerBounds.left,
      pointerY: anchorClientY - containerBounds.top,
      containerWidth: containerBounds.width,
      containerHeight: containerBounds.height,
      tooltipWidth: measuredWidth,
      tooltipHeight: measuredHeight,
    });
    setHoveredSliceStatus(status);
    setTooltipPosition(position);
  }, []);

  useEffect(() => {
    if (hoveredRowStatus && !entries.some(({ status }) => status === hoveredRowStatus)) {
      setHoveredRowStatus(null);
    }
  }, [entries, hoveredRowStatus]);

  useEffect(() => {
    hideTooltip();
  }, [breakdownKey, hideTooltip, selectedStatusKey]);

  const totalDescription = `${total} total ${total === 1 ? "indent" : "indents"}`;
  const hasSeparators = chartEntries.length > 1;

  return (
    <div
      ref={containerRef}
      data-testid="status-breakdown-layout"
      className="relative grid min-w-0 gap-3 md:grid-cols-[minmax(280px,1.15fr)_minmax(260px,0.85fr)] md:items-center md:gap-4"
    >
      <div
        data-testid="status-donut-container"
        className="relative mx-auto h-[250px] w-full max-w-[250px] sm:h-[290px] sm:max-w-[290px] md:h-[330px] md:max-w-[330px]"
        onMouseLeave={hideTooltip}
      >
        <div
          role="img"
          aria-label={`Indent status donut chart. ${totalDescription}.`}
          className="absolute inset-0"
        >
          {total > 0 ? (
            <ResponsiveContainer width="100%" height="100%">
              <PieChart accessibilityLayer>
                <Pie
                  className="status-donut"
                  data={chartEntries}
                  dataKey="count"
                  nameKey="label"
                  cx="50%"
                  cy="50%"
                  outerRadius="90%"
                  innerRadius="69%"
                  paddingAngle={0}
                  cornerRadius={0}
                  startAngle={90}
                  endAngle={-270}
                  stroke="none"
                  rootTabIndex={-1}
                  isAnimationActive={false}
                  activeIndex={-1}
                  inactiveShape={(sectorProps: DonutSectorProps) => {
                    const entry = sectorProps.payload;
                    const status = entry?.status ?? "";
                    return (
                      <DonutSector
                        {...sectorProps}
                        isActive={status === highlightedSliceStatus}
                        isSelected={selectedStatusSet.has(status)}
                        hasActiveStatus={Boolean(highlightedSliceStatus)}
                        hasSeparators={hasSeparators}
                        onActivate={(event) => updateTooltip(status, event)}
                        onMove={(event) => updateTooltip(status, event)}
                        onDeactivate={hideTooltip}
                      />
                    );
                  }}
                >
                  {chartEntries.map((entry) => (
                    <Cell
                      key={entry.status}
                      fill={STATUS_COLOR[entry.status] ?? DEFAULT_STATUS_COLOR}
                    />
                  ))}
                </Pie>
              </PieChart>
            </ResponsiveContainer>
          ) : (
            <svg
              data-testid="status-empty-donut-track"
              aria-hidden="true"
              viewBox="0 0 240 240"
              className="h-full w-full"
            >
              <circle
                cx="120"
                cy="120"
                r="84"
                fill="none"
                stroke="var(--color-line)"
                strokeWidth="30"
              />
            </svg>
          )}
        </div>
        <DonutCentre total={total} />
      </div>

      {total > 0 ? (
        <div
          aria-label="Status breakdown"
          data-testid="status-breakdown-legend"
          className="grid w-full min-w-0 max-w-[320px] justify-self-center content-center gap-1"
        >
          {entries.map((entry) => {
            const isActive = highlightedSliceStatus === entry.status;
            const isHovered = hoveredRowStatus === entry.status;
            const isSelected = entry.isSelectable && selectedStatusSet.has(entry.status);
            const rowClassName = `grid min-h-9 min-w-0 grid-cols-[0.625rem_minmax(0,1fr)_2.5rem_3rem] items-center gap-x-2 rounded-lg px-1.5 py-1 text-left text-sm transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40 ${
              isSelected
                ? "bg-brand-050 text-ink ring-1 ring-brand/20"
                : isActive || isHovered
                  ? "bg-content2/70 text-ink"
                  : "text-body hover:bg-content2/70"
            }`;
            const rowContent = (
              <>
                <span
                  aria-hidden="true"
                  data-testid={`status-marker-${entry.status}`}
                  className={`h-2.5 w-2.5 rounded-full ${STATUS_INDICATOR[entry.status] ?? "bg-neutral"}`}
                />
                <span className="min-w-0 break-words font-medium leading-4">{entry.label}</span>
                <span
                  data-testid={`status-legend-count-${entry.status}`}
                  className="text-right font-semibold tabular-nums text-ink"
                >
                  {entry.count}
                </span>
                <span
                  data-testid={`status-legend-percentage-${entry.status}`}
                  className="text-right text-xs tabular-nums text-muted"
                >
                  {entry.percentage}%
                </span>
              </>
            );

            return (
              <div
                key={entry.status}
                onMouseEnter={() => {
                  setHoveredRowStatus(entry.status);
                  showTooltipBySlice(entry.status);
                }}
                onMouseLeave={() => {
                  setHoveredRowStatus(null);
                  hideTooltip();
                }}
                data-testid={`status-legend-row-${entry.status}`}
                data-active={isActive ? "true" : "false"}
                data-hovered={isHovered ? "true" : "false"}
                data-selected={isSelected ? "true" : "false"}
                aria-label={accessibleStatusLabel(entry)}
                className={rowClassName}
              >
                {rowContent}
              </div>
            );
          })}
        </div>
      ) : (
        <p className="mx-auto max-w-sm text-center text-sm text-muted md:text-left">
          No status data available for the selected filters.
        </p>
      )}
      {tooltipEntry && tooltipPosition && (
        <StatusTooltip
          entry={tooltipEntry}
          position={tooltipPosition}
          tooltipRef={tooltipRef}
        />
      )}
    </div>
  );
}
