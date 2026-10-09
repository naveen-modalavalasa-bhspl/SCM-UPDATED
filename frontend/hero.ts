import { heroui } from "@heroui/react";

// Mapped from the HeroUI reference theme (indigo accent, soft cool-gray surfaces,
// generous radii) into HeroUI v2's plugin theme.
export default heroui({
  themes: {
    light: {
      colors: {
        background: "#f4f5f9",
        foreground: "#1b2130",
        divider: "#e6e8ef",
        focus: "#CC004C",
        content1: "#ffffff",
        content2: "#f6f7fb",
        default: { DEFAULT: "#eceef4", foreground: "#1b2130" },
        primary: { DEFAULT: "#CC004C", foreground: "#ffffff" },
        secondary: { DEFAULT: "#141a2a", foreground: "#ffffff" },
        success: { DEFAULT: "#30a46c", foreground: "#ffffff" },
        warning: { DEFAULT: "#d99a0b", foreground: "#ffffff" },
        danger: { DEFAULT: "#e5484d", foreground: "#ffffff" },
      },
    },
    dark: {
      colors: {
        background: "#0a0e18",
        foreground: "#e6ebf7",
        divider: "#272e42",
        focus: "#FF7BA8",
        content1: "#121828",
        content2: "#1a2134",
        content3: "#232b42",
        default: { DEFAULT: "#1f2639", foreground: "#e6ebf7" },
        primary: { DEFAULT: "#E0447B", foreground: "#ffffff" },
        secondary: { DEFAULT: "#2a3350", foreground: "#ffffff" },
        success: { DEFAULT: "#2fa96f", foreground: "#ffffff" },
        warning: { DEFAULT: "#c78f22", foreground: "#ffffff" },
        danger: { DEFAULT: "#d64550", foreground: "#ffffff" },
      },
    },
  },
  layout: {
    radius: { small: "8px", medium: "12px", large: "18px" },
    fontSize: { tiny: "0.72rem", small: "0.85rem", medium: "0.95rem", large: "1.1rem" },
  },
});
