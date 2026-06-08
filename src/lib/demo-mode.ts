// Single source of truth for whether the build should expose demo
// affordances (role-switcher chips, pre-filled login creds, the
// demo-creds short-circuit on /login, the demo banner on the role
// chip subheading, etc.).
//
// DEMO_MODE is TRUE when:
//   - The dev server is running (import.meta.env.DEV is true), OR
//   - The deployment explicitly opts in via VITE_DEMO_MODE=true
//
// In production builds (npm run build), import.meta.env.DEV is FALSE.
// VITE_DEMO_MODE should only be set on staging/preview deployments
// where demo creds make onboarding easier. A CI assertion at build
// time (see package.json prebuild) fails the build if both
// VITE_DEMO_MODE=true AND VERCEL_ENV=production are present, to
// prevent accidental demo-mode-in-prod.
//
// Adding a new demo affordance? Import DEMO_MODE from here — do NOT
// re-derive the expression inline. A future change (e.g. only-on-
// Tuesdays demo mode for a special launch) should touch one file.

export const DEMO_MODE: boolean =
  import.meta.env.DEV || import.meta.env.VITE_DEMO_MODE === "true";
