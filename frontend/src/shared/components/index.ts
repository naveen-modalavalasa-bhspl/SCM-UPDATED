/* Shared design system — import module UI from here.
 * e.g. import { Button, Card, StatCard, StatusPill, ResponsiveList, Can } from "@/shared/components";
 */
export { BackLink, Button, Card, PageHeader, StatCard, Field, Input, Textarea, Select, selectOnFocus } from "./ui";
export { QuantityInput, type QuantityInputProps } from "./QuantityInput";
export { StatusPill } from "./StatusPill";
export { QuantityChanges, type QuantityChangeRow } from "./QuantityChanges";
export { NotificationItem, timeAgo } from "./NotificationItem";
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
export { PrintTemplate, PrintPanel, SectionTitle } from "./PrintTemplate";
export type { PrintTemplateProps, PrintField, PrintBlock, PrintColumn } from "./PrintTemplate";
export {
  COMPANY_FALLBACK, resolveCompany, useCompanyProfile, companyProfileKey,
} from "./companyProfile";
export type { CompanyProfile } from "./companyProfile";
export { FilterMenu, type FilterOption } from "./FilterMenu";
export * from "./filterChrome";
export { FilterBar, SearchField, FilterToggle, FilterDateRange } from "./FilterBar";
// The one attachment preview — images, PDFs and text, paged with the keyboard. Shared
// because every module files paperwork against its documents and none of them should
// draw their own lightbox.
export { SharedAttachmentViewer, type Attachment } from "./SharedAttachmentViewer";

// The clickable KPI strip every module's overview leads with. One definition, so a
// tile means the same thing and looks the same wherever it appears.
export {
  KpiTile, KpiTiles, ContextStrip, TONES, shortMoney, shortQty,
} from "./KpiStrip";
export type { KpiTileSpec, ContextStatSpec, Tone } from "./KpiStrip";

// The document a document came from — the backward link (indent / PO / GRN) that every
// list already held in its data and none of them drew, so tracing a row to its origin
// meant opening rows one at a time.
export { SourceRef, SourceRefLine, type SourceRefCandidate } from "./SourceRef";

// The cold-open splash: the SCM mark lit with the brand sweep, shown while the
// session is being resolved. Not for in-page waits — those stay quiet.
export { AppSplash } from "./AppSplash";

// The top of every document form: the fields its series asks for, beside the number
// they make. Fields and number parts are served, so a pattern edit needs no screen edit.
export { DocumentNumberCard } from "./DocumentNumberCard";
export { DocumentScopeStrip } from "./DocumentScopeStrip";
export * from "./tones";
export {
  PackageCheckModal, packGroups, packMix, packPathLabel, shortPackCode,
  type InnerCheck, type PackageCheck, type PackageToCheck,
} from "./PackageCheckModal";
