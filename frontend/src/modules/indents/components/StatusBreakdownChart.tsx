import { useMemo, useState } from "react";
import {
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  Sector,
  Tooltip,
} from "recharts";
import type { SectorProps } from "recharts";
import { INDENT_STATUS_OPTIONS } from "../constants";

const STATUS_INDICATOR: Record<string, string> = {
  DRAFT: "bg-neutral",
  PENDING_APPROVAL: "bg-warn",
  SUBMITTED: "bg-warn",
  APPROVED: "bg-ok",
  AWAITING_ALLOCATION: "bg-info",
  ALLOCATED: "bg-info",
  PARTIALLY_FULFILLED: "bg-info",
  PENDING_PROCUREMENT: "bg-purple-500",
  ORDERED: "bg-blue-600",
  PARTIALLY_ORDERED: "bg-blue-600",
  REJECTED: "bg-bad",
  CLOSED: "bg-neutral",
};

const STATUS_COLOR: Record<string, string> = {
  DRAFT: "var(--color-neutral)",
  PENDING_APPROVAL: "var(--color-warn)",
  SUBMITTED: "var(--color-warn)",
  APPROVED: "var(--color-ok)",
  AWAITING_ALLOCATION: "var(--color-info)",
  ALLOCATED: "var(--color-info)",
  PARTIALLY_FULFILLED: "var(--color-info)",
  PENDING_PROCUREMENT: "#8b5cf6",
  ORDERED: "#2563eb",
  PARTIALLY_ORDERED: "#2563eb",
  REJECTED: "var(--color-bad)",
  CLOSED: "var(--color-neutral)",
};

const STATUS_LABEL = new Map(
  INDENT_STATUS_OPTIONS.map(({ value, label }) => [value, label]),
);

interface StatusSlice {
  status: string;
  label: string;
  count: number;
  percentage: number;
}

type Pseudo3DSectorProps = SectorProps & {
  midAngle?: number;
  payload?: StatusSlice;
};

type Pseudo3DShapeProps = Pseudo3DSectorProps & {
  isHovered: boolean;
  canLift: boolean;
};

interface TooltipPayload {
  payload?: StatusSlice;
}

const PERSPECTIVE_SCALE_Y = 0.75;
const PIE_DEPTH = 14;
const DEPTH_LAYER_COUNT = 7;
const HOVER_LIFT = 3;
const DEFAULT_STATUS_COLOR = "var(--color-neutral)";
const DEPTH_OFFSETS = Array.from(
  { length: DEPTH_LAYER_COUNT },
  (_, index) => PIE_DEPTH - index * (PIE_DEPTH / DEPTH_LAYER_COUNT),
);

function darkenColor(color: string, amount = 28) {
  const darkness = Math.min(45, Math.max(0, Math.round(amount)));
  return `color-mix(in srgb, ${color} ${100 - darkness}%, black ${darkness}%)`;
}

function perspectiveTransform(cx: number, cy: number) {
  return `translate(${cx} ${cy}) scale(1 ${PERSPECTIVE_SCALE_Y}) translate(${-cx} ${-cy})`;
}

function hoverOffset(midAngle: number | undefined, isHovered: boolean, canLift: boolean) {
  if (!isHovered || !canLift) return { x: 0, y: 0 };
  const radians = -((midAngle ?? 0) * Math.PI) / 180;
  return {
    x: Number((Math.cos(radians) * HOVER_LIFT).toFixed(2)),
    y: Number((Math.sin(radians) * HOVER_LIFT).toFixed(2)),
  };
}

function PieDepthSector({
  cx = 0,
  cy = 0,
  innerRadius = 0,
  outerRadius = 0,
  startAngle = 0,
  endAngle = 0,
  midAngle,
  payload,
  fill = DEFAULT_STATUS_COLOR,
  fillOpacity,
  isHovered,
  canLift,
}: Pseudo3DShapeProps) {
  const status = payload?.status ?? "UNKNOWN";
  const lift = hoverOffset(midAngle, isHovered, canLift);

  return (
    <g
      aria-hidden="true"
      data-testid={`status-pie-depth-group-${status}`}
      data-layer="depth"
      data-status={status}
      pointerEvents="none"
      transform={`translate(${lift.x} ${lift.y})`}
    >
      {DEPTH_OFFSETS.map((depthOffset, index) => {
        const darkness = 24 + (depthOffset / PIE_DEPTH) * 10;
        const depthColor = darkenColor(fill, darkness);

        return (
          <g
            key={depthOffset}
            aria-hidden="true"
            pointerEvents="none"
            transform={`translate(0 ${depthOffset})`}
          >
            <Sector
              cx={cx}
              cy={cy}
              innerRadius={0}
              outerRadius={outerRadius}
              startAngle={startAngle}
              endAngle={endAngle}
              cornerRadius={0}
              fill={depthColor}
              fillOpacity={fillOpacity}
              stroke={depthColor}
              strokeWidth={1}
              pointerEvents="none"
              focusable={false}
              aria-hidden="true"
              transform={perspectiveTransform(cx, cy)}
              data-testid={`status-pie-depth-${status}-${index}`}
              data-layer="depth"
              data-status={status}
              data-base-color={fill}
              data-depth-offset={depthOffset}
              data-inner-radius={innerRadius}
            />
          </g>
        );
      })}
    </g>
  );
}

function PieTopSector({
  cx = 0,
  cy = 0,
  innerRadius = 0,
  outerRadius = 0,
  startAngle = 0,
  endAngle = 0,
  midAngle,
  payload,
  fill = DEFAULT_STATUS_COLOR,
  fillOpacity,
  className,
  isHovered,
  canLift,
  ...sectorProps
}: Pseudo3DShapeProps) {
  const status = payload?.status ?? "UNKNOWN";
  const lift = hoverOffset(midAngle, isHovered, canLift);

  return (
    <g
      data-testid={`status-pie-top-group-${status}`}
      data-layer="top"
      data-status={status}
      transform={`translate(${lift.x} ${lift.y})`}
    >
      <Sector
        {...sectorProps}
        cx={cx}
        cy={cy}
        innerRadius={0}
        outerRadius={outerRadius}
        startAngle={startAngle}
        endAngle={endAngle}
        cornerRadius={0}
        fill={fill}
        fillOpacity={fillOpacity}
        stroke={canLift ? "#ffffff" : "none"}
        strokeWidth={canLift ? 1.25 : 0}
        transform={perspectiveTransform(cx, cy)}
        className={`status-pie-top-sector cursor-pointer outline-none ${className ?? ""}`}
        data-testid={`status-pie-top-${status}`}
        data-layer="top"
        data-status={status}
        data-base-color={fill}
        data-inner-radius={innerRadius}
      />
    </g>
  );
}

function humanizeStatus(status: string) {
  const configuredLabel = STATUS_LABEL.get(status);
  const label = configuredLabel ?? status.replace(/_/g, " ").toLowerCase();
  return label.replace(/\b\w/g, (character) => character.toUpperCase());
}

export function buildStatusBreakdownData(byStatus: Record<string, number>) {
  const positiveStatuses = Object.entries(byStatus)
    .filter(([, count]) => Number.isFinite(count) && count > 0)
    .sort((left, right) => right[1] - left[1]);
  const total = positiveStatuses.reduce((sum, [, count]) => sum + count, 0);
  const entries: StatusSlice[] = positiveStatuses.map(([status, count]) => {
    const exactPercentage = (count / total) * 100;
    return {
      status,
      label: humanizeStatus(status),
      count,
      percentage: Math.round(exactPercentage),
    };
  });

  return { entries, total };
}

function StatusTooltip({
  active,
  payload,
}: {
  active?: boolean;
  payload?: TooltipPayload[];
}) {
  const entry = payload?.[0]?.payload;
  if (!active || !entry) return null;

  return (
    <div
      role="tooltip"
      className="pointer-events-none w-36 rounded-lg border border-line/80 bg-content1 px-3 py-2 shadow-md"
    >
      <p className="text-xs font-semibold leading-4 text-ink">{entry.label}</p>
      <p className="mt-1 text-xs font-medium tabular-nums text-body">
        {entry.count} {entry.count === 1 ? "indent" : "indents"}
      </p>
      <p className="text-[11px] tabular-nums text-muted">
        {entry.percentage}% of total
      </p>
    </div>
  );
}

export function StatusBreakdownChart({
  byStatus,
  onStatusClick,
}: {
  byStatus: Record<string, number>;
  onStatusClick: (status: string) => void;
}) {
  const { entries, total } = useMemo(
    () => buildStatusBreakdownData(byStatus),
    [byStatus],
  );
  const [hoveredStatus, setHoveredStatus] = useState<string | null>(null);
  const activeStatus = entries.some(({ status }) => status === hoveredStatus)
    ? hoveredStatus
    : null;
  const indentLabel = total === 1 ? "Indent" : "Indents";
  const totalDescription = `${total} total ${total === 1 ? "indent" : "indents"}`;
  const totalBadge = (
    <span
      data-testid="status-total-badge"
      aria-label={`Status breakdown total: ${total} ${indentLabel.toLowerCase()}`}
      className="-mt-2 mb-3 ml-auto flex h-7 w-fit items-center rounded-full border border-line/70 bg-content2 px-2.5 text-xs font-semibold tabular-nums text-body shadow-sm md:absolute md:right-5 md:top-4 md:mb-0 md:mt-0"
    >
      {total} {indentLabel}
    </span>
  );

  if (!total) {
    return (
      <>
        {totalBadge}
        <div className="grid min-h-40 place-items-center rounded-lg border border-dashed border-line bg-content2/40 px-4 text-center">
          <p className="text-sm text-muted">No indent status data available</p>
        </div>
      </>
    );
  }

  return (
    <>
      {totalBadge}
      <div
        data-testid="status-breakdown-layout"
        className="grid min-w-0 gap-4 md:grid-cols-[minmax(0,2fr)_minmax(0,3fr)] md:items-center md:gap-6"
      >
        <div
          role="img"
          aria-label={`Status breakdown donut chart. ${totalDescription}.`}
          className="relative mx-auto h-[250px] w-full max-w-[300px]"
        >
          <ResponsiveContainer width="100%" height="100%">
            <PieChart accessibilityLayer>
              {/* Recharts 2.x applies custom Pie sector shapes through inactiveShape. */}
              <Pie
                aria-hidden="true"
                className="status-pie-depth pointer-events-none"
                data={entries}
                dataKey="count"
                nameKey="label"
                cx="50%"
                cy="46%"
                outerRadius="88%"
                innerRadius={0}
                paddingAngle={0}
                cornerRadius={0}
                startAngle={90}
                endAngle={-270}
                stroke="none"
                isAnimationActive={false}
                rootTabIndex={-1}
                tooltipType="none"
                pointerEvents="none"
                activeIndex={-1}
                inactiveShape={(sectorProps: Pseudo3DSectorProps) => (
                  <PieDepthSector
                    {...sectorProps}
                    isHovered={sectorProps.payload?.status === activeStatus}
                    canLift={entries.length > 1}
                  />
                )}
              >
                {entries.map((entry) => (
                  <Cell
                    key={entry.status}
                    fill={STATUS_COLOR[entry.status] ?? DEFAULT_STATUS_COLOR}
                    fillOpacity={
                      activeStatus ? (activeStatus === entry.status ? 1 : 0.48) : 0.94
                    }
                  />
                ))}
              </Pie>

              <Pie
                className="status-pie-top"
                data={entries}
                dataKey="count"
                nameKey="label"
                cx="50%"
                cy="46%"
                outerRadius="88%"
                innerRadius={0}
                paddingAngle={0}
                cornerRadius={0}
                startAngle={90}
                endAngle={-270}
                stroke="none"
                isAnimationActive={false}
                rootTabIndex={0}
                activeIndex={-1}
                inactiveShape={(sectorProps: Pseudo3DSectorProps) => (
                  <PieTopSector
                    {...sectorProps}
                    isHovered={sectorProps.payload?.status === activeStatus}
                    canLift={entries.length > 1}
                  />
                )}
                onMouseEnter={(entry: StatusSlice) => setHoveredStatus(entry.status)}
                onMouseLeave={() => setHoveredStatus(null)}
                onClick={(entry: StatusSlice) => onStatusClick(entry.status)}
              >
                {entries.map((entry) => (
                  <Cell
                    key={entry.status}
                    fill={STATUS_COLOR[entry.status] ?? DEFAULT_STATUS_COLOR}
                    fillOpacity={
                      activeStatus ? (activeStatus === entry.status ? 1 : 0.48) : 0.94
                    }
                    aria-label={`${entry.label}: ${entry.count} ${entry.count === 1 ? "indent" : "indents"}, ${entry.percentage}%`}
                    className="cursor-pointer outline-none transition-opacity duration-150"
                  />
                ))}
              </Pie>
              <Tooltip
                content={<StatusTooltip />}
                cursor={false}
                isAnimationActive={false}
                offset={16}
                allowEscapeViewBox={{ x: false, y: false }}
                wrapperStyle={{
                  maxWidth: "9rem",
                  outline: "none",
                  pointerEvents: "none",
                  zIndex: 20,
                }}
              />
            </PieChart>
          </ResponsiveContainer>
        </div>

        <div
          aria-label="Status breakdown legend"
          data-testid="status-breakdown-legend"
          className="grid min-w-0 content-center gap-1 md:max-h-[260px] md:overflow-y-auto md:pr-1"
        >
          {entries.map((entry) => {
            const isActive = activeStatus === entry.status;
            return (
              <button
                key={entry.status}
                type="button"
                onClick={() => onStatusClick(entry.status)}
                onMouseEnter={() => setHoveredStatus(entry.status)}
                onMouseLeave={() => setHoveredStatus(null)}
                onFocus={() => setHoveredStatus(entry.status)}
                onBlur={() => setHoveredStatus(null)}
                data-testid={`status-legend-row-${entry.status}`}
                data-active={isActive ? "true" : "false"}
                aria-label={`${entry.label}: ${entry.count} ${entry.count === 1 ? "indent" : "indents"}, ${entry.percentage}%`}
                className={`grid min-h-9 min-w-0 grid-cols-[minmax(0,1fr)_2.5rem_3rem] items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30 ${
                  isActive ? "bg-content2 text-ink" : "text-body hover:bg-content2/70"
                }`}
              >
                <span className="flex min-w-0 items-center gap-2">
                  <span
                    aria-hidden="true"
                    className={`h-2.5 w-2.5 shrink-0 rounded-full ${STATUS_INDICATOR[entry.status] ?? "bg-neutral"}`}
                  />
                  <span className="min-w-0 break-words font-medium leading-4">
                    {entry.label}
                  </span>
                </span>
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
              </button>
            );
          })}
        </div>
      </div>
    </>
  );
}
