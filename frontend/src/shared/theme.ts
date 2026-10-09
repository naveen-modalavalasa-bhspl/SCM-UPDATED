/* Dark mode, app-wide. One class on <html> flips every token (index.css .dark)
 * and HeroUI's dark palette (hero.ts). Choice persists in localStorage;
 * "system" follows the OS and updates live. */

export type ThemeChoice = "light" | "dark" | "system";

const STORAGE_KEY = "scm-theme";

export const THEME_OPTIONS: { value: ThemeChoice; label: string }[] = [
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
  { value: "system", label: "System" },
];

/** LIGHT is the default, not "system" (changed 2026-08-26).
 *
 *  Following the OS meant an employee whose phone was in dark mode was handed a dark
 *  ERP they never asked for, on a screen where the theme switch was two permissions
 *  away — see the picker on Profile. Nothing stored now means light; "system" is still
 *  offered, but only when somebody chooses it. */
export function getTheme(): ThemeChoice {
  const stored = localStorage.getItem(STORAGE_KEY);
  return stored === "light" || stored === "dark" || stored === "system"
    ? stored
    : "light";
}

function systemPrefersDark() {
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

/** Call once at startup and again whenever the choice changes. */
export function applyTheme(choice: ThemeChoice = getTheme()) {
  const dark = choice === "dark" || (choice === "system" && systemPrefersDark());
  document.documentElement.classList.toggle("dark", dark);
}

/** "system" is now STORED rather than cleared. With light as the fallback, clearing the
 *  key would read back as "light" — the System button would not stay pressed and the
 *  OS would stop being followed the moment the page reloaded. */
export function setTheme(choice: ThemeChoice) {
  localStorage.setItem(STORAGE_KEY, choice);
  applyTheme(choice);
}

/** Follows the OS while on "system". Returns a cleanup fn. */
export function watchSystemTheme() {
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  const onChange = () => {
    if (getTheme() === "system") applyTheme("system");
  };
  media.addEventListener("change", onChange);
  return () => media.removeEventListener("change", onChange);
}
