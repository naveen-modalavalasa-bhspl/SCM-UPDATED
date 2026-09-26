/** Copy text in secure browsers and on the application's plain-HTTP LAN deployment. */
export async function writeToClipboard(text: string): Promise<boolean> {
  try {
    const written = navigator.clipboard?.writeText(text);
    if (written) {
      await written;
      return true;
    }
  } catch {
    // Clipboard API is unavailable outside secure contexts; use the fallback below.
  }

  if (typeof document === "undefined") return false;
  const dialogs = document.querySelectorAll<HTMLElement>("[role='dialog'], dialog");
  const host = dialogs.length ? dialogs[dialogs.length - 1] : document.body;
  const restore = document.activeElement as HTMLElement | null;
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.left = "-9999px";
  area.style.top = "0";
  host.appendChild(area);
  area.focus();
  area.select();
  area.setSelectionRange(0, text.length);
  try {
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    area.remove();
    if (restore && restore !== document.body) restore.focus?.();
  }
}
