/* Shared design system — import module UI from here.
 * e.g. import { Button, Card, StatCard, StatusPill, ResponsiveList, Can } from "@/shared/components";
 */
export { BackLink, Button, Card, PageHeader, StatCard, Field, Input, Select, selectOnFocus } from "./ui";
export { StatusPill } from "./StatusPill";
export { ResponsiveList, type Column } from "./ResponsiveList";
export { ResponsiveGrid } from "./ResponsiveGrid";
export { ScrollBox } from "./ScrollBox";
export { FormActions } from "./FormActions";
export { Placeholder } from "./Placeholder";
export { SubNav, type SubNavItem } from "./SubNav";
export { Can } from "./Can";
export { Alert, type AlertTone } from "./Alert";
export { ErrorBanner, EmptyState, ConfirmModal } from "./Feedback";
// The one notification card — the toast strip, the alert dialog and the confirm
// modal are all this, so a popup cannot be styled differently by being written
// somewhere else.
export {
  NoticeCard, NoticeChip, NoticeCountdown, NOTICE_TONES, NOTICE_WIDTH, type NoticeTone,
} from "./notice";
export { ToastProvider, useToast, type ToastInput, type ToastContent } from "./Toast";
// The one translation from a failure to a sentence. Import it directly when a
// screen needs the level or the field rather than just the message.
export { describeError, errorMessage, isAnnouncedGlobally } from "@/shared/api/errors";
export type { Notice, NoticeLevel } from "@/shared/api/errors";
export { useAction } from "./useAction";
export { PrintTemplate } from "./PrintTemplate";
export { FilterMenu, type FilterOption } from "./FilterMenu";
export * from "./filterChrome";
export { FilterBar, SearchField, FilterToggle, FilterDateRange } from "./FilterBar";

// The clickable KPI strip every module's overview leads with. One definition, so a
// tile means the same thing and looks the same wherever it appears.
export {
  KpiTile, KpiTiles, ContextStrip, TONES, shortMoney, shortQty,
} from "./KpiStrip";
export type { KpiTileSpec, ContextStatSpec, Tone } from "./KpiStrip";
