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
        focus: "#3e63dd",
        content1: "#ffffff",
        content2: "#f6f7fb",
        default: { DEFAULT: "#eceef4", foreground: "#1b2130" },
        primary: { DEFAULT: "#3e63dd", foreground: "#ffffff" },
        secondary: { DEFAULT: "#141a2a", foreground: "#ffffff" },
        success: { DEFAULT: "#30a46c", foreground: "#ffffff" },
        warning: { DEFAULT: "#d99a0b", foreground: "#ffffff" },
        danger: { DEFAULT: "#e5484d", foreground: "#ffffff" },
      },
    },
  },
  layout: {
    radius: { small: "8px", medium: "12px", large: "18px" },
    fontSize: { tiny: "0.72rem", small: "0.85rem", medium: "0.95rem", large: "1.1rem" },
  },
});
