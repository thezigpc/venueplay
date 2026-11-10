import type { ThemeColors, VenueTheme } from "./protocol.js";

export const DEFAULT_THEME: VenueTheme = {
  colors: {
    background: "#101528",
    surface: "#1c2346",
    text: "#f4f6ff",
    primary: "#f2b33d",
    accent: "#4cc9f0",
  },
  font: "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
  radius: 12,
};

/** CSS custom properties every branded game can use. */
export const CSS_VARS = {
  background: "--venue-bg",
  surface: "--venue-surface",
  text: "--venue-text",
  primary: "--venue-primary",
  accent: "--venue-accent",
  font: "--venue-font",
  radius: "--venue-radius",
  logo: "--venue-logo",
} as const;

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;
export const isHexColor = (v: unknown): v is string => typeof v === "string" && HEX.test(v);

export function themeCssVars(theme: VenueTheme): Record<string, string> {
  const vars: Record<string, string> = {
    [CSS_VARS.background]: theme.colors.background,
    [CSS_VARS.surface]: theme.colors.surface,
    [CSS_VARS.text]: theme.colors.text,
    [CSS_VARS.primary]: theme.colors.primary,
    [CSS_VARS.accent]: theme.colors.accent,
  };
  if (theme.font) vars[CSS_VARS.font] = theme.font;
  if (theme.radius !== undefined) vars[CSS_VARS.radius] = `${theme.radius}px`;
  if (theme.logoUrl) vars[CSS_VARS.logo] = `url("${theme.logoUrl.replace(/"/g, "%22")}")`;
  return vars;
}

/** A stylesheet with the venue variables, for <link> injection into level-0/1 games. */
export function themeToCss(theme: VenueTheme, selector = ":root"): string {
  const body = Object.entries(themeCssVars(theme))
    .map(([k, v]) => `  ${k}: ${v};`)
    .join("\n");
  return `${selector} {\n${body}\n}\n`;
}

/** Venue theme with a per-game accent override. */
export function withAccent(theme: VenueTheme, accent?: string): VenueTheme {
  if (!accent || !isHexColor(accent)) return theme;
  return { ...theme, colors: { ...theme.colors, accent } };
}

// ---------------------------------------------------------------- contrast (WCAG 2.x)

function hexToRgb(hex: string): [number, number, number] {
  let h = hex.slice(1);
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  const n = parseInt(h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function luminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex).map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * Guardrails for venue branding: TV text must stay readable across a room.
 * Returns human-readable problems; an empty list means the theme is fine.
 */
export function checkTheme(theme: VenueTheme): string[] {
  const problems: string[] = [];
  const c = theme.colors;
  for (const key of Object.keys(c) as (keyof ThemeColors)[]) {
    if (!isHexColor(c[key])) problems.push(`${key} must be a hex color like #1a2b3c`);
  }
  if (problems.length) return problems;
  const pairs: [keyof ThemeColors, keyof ThemeColors, number][] = [
    ["text", "background", 4.5],
    ["text", "surface", 4.5],
    ["primary", "background", 3],
    ["accent", "background", 3],
  ];
  for (const [fg, bg, min] of pairs) {
    const ratio = contrastRatio(c[fg], c[bg]);
    if (ratio < min) problems.push(`${fg} on ${bg} contrast is ${ratio.toFixed(1)}:1; needs at least ${min}:1`);
  }
  return problems;
}
