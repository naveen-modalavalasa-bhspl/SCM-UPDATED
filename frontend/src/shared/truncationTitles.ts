/**
 * Full text on hover for anything the layout has cut short — in every module.
 *
 * Item names are long ("27-inch Full HD LED Monitor with HDMI…") and every dropdown,
 * line cell and card truncates them, so on GRN, Material Inward, QC, Material Issue,
 * PO and the rest a storekeeper picking between two items could read only the first
 * twenty characters of each. Adding `title` at each of the hundreds of `truncate`
 * call sites would be missed on the next screen written, so — like `installNumberGuard`
 * — one listener does it for the whole app:
 *
 * on mouse-over, the element under the pointer (or one of its near ancestors) that is
 * ACTUALLY overflowing — wider than its box, or clamped taller — gets a native `title`
 * holding its full text (an input's or textarea's VALUE). Text that fits gets nothing,
 * so short labels do not grow a pointless tooltip.
 *
 * A `title` somebody wrote is never touched: the ones this sets are marked
 * `data-auto-title`, and only those are refreshed or removed when the text changes or
 * stops overflowing.
 */

const MARK = "data-auto-title";
/** How far up from the hovered node to look. Ellipsis sits on the span holding the
 *  text or its immediate wrapper; walking further reaches whole rows and cards. */
const MAX_DEPTH = 4;

function isOverflowing(el: HTMLElement): boolean {
  return el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1;
}

function fullText(el: HTMLElement): string {
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    return el.value || el.placeholder || "";
  }
  return (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();
}

function clips(el: HTMLElement): boolean {
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return true;
  const style = getComputedStyle(el);
  return style.textOverflow === "ellipsis"
    || style.overflow === "hidden" || style.overflowX === "hidden"
    || style.webkitLineClamp !== "none" && style.webkitLineClamp !== "";
}

function onOver(event: MouseEvent) {
  let node = event.target as HTMLElement | null;
  for (let depth = 0; node && depth < MAX_DEPTH; depth += 1, node = node.parentElement) {
    if (!(node instanceof HTMLElement)) return;
    const own = node.getAttribute("title");
    const auto = node.hasAttribute(MARK);
    // Somebody wrote a title on purpose — it says what they meant, leave it.
    if (own !== null && !auto) return;
    // Only an element that clips its own content: a scrolling list or a whole card is
    // "overflowing" too, and a tooltip of everything inside it helps nobody.
    if (!clips(node) || !isOverflowing(node)) {
      if (auto) { node.removeAttribute("title"); node.removeAttribute(MARK); }
      continue;
    }
    const text = fullText(node);
    if (!text || text.length > 500) return;
    if (own !== text) node.setAttribute("title", text);
    node.setAttribute(MARK, "");
    return;
  }
}

let installed = false;

export function installTruncationTitles(): void {
  if (installed || typeof document === "undefined") return;
  installed = true;
  // Capture + passive: the dropdowns render in portals and some stop propagation.
  document.addEventListener("mouseover", onOver, { capture: true, passive: true });
}
