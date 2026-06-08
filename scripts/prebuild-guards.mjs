#!/usr/bin/env node
// Pre-build CI assertions. Fails the build BEFORE any vite output is written
// when the deploy environment + env vars combine in a way that would ship
// demo affordances (pre-filled creds, role switcher, demo-creds short-circuit)
// to a production host.
//
// This is the belt-and-braces complement to src/lib/demo-mode.ts — that file
// keeps the runtime check single-source-of-truth; this file keeps the build
// from succeeding at all in a configuration mistake.

const VERCEL_ENV = process.env.VERCEL_ENV || "";
const DEMO_MODE = process.env.VITE_DEMO_MODE === "true";
const USE_SUPABASE = process.env.VITE_USE_SUPABASE === "true";

const failures = [];

// Guard 1 — demo mode must NEVER be on for a production Vercel deployment.
// VERCEL_ENV is set by Vercel automatically: 'production' for the production
// branch, 'preview' for PR previews, 'development' for `vercel dev`.
if (VERCEL_ENV === "production" && DEMO_MODE) {
  failures.push(
    "VITE_DEMO_MODE=true is set on a production Vercel deployment. " +
      "This would ship the demo-creds short-circuit, pre-filled login email, " +
      "and role-switcher chips to real customers. " +
      "Remove VITE_DEMO_MODE from the Production environment in the Vercel " +
      "dashboard (Project Settings -> Environment Variables) and redeploy.",
  );
}

// Guard 2 — production deployments must use Supabase (not mock mode). The
// mock-mode build serves the bundled mockData seed instead of the real
// database; deploying it would show fake drivers/vehicles/jobs to customers.
// Skip this guard outside Vercel (local prod-like builds are fine in mock).
if (VERCEL_ENV === "production" && !USE_SUPABASE) {
  failures.push(
    "VITE_USE_SUPABASE is not 'true' on a production Vercel deployment. " +
      "The build would render mockData seed (Tom Morrison, TRK-07 etc.) " +
      "instead of the real Supabase backend. Set VITE_USE_SUPABASE=true in " +
      "the Production environment.",
  );
}

if (failures.length > 0) {
  console.error("\n[31m✖ prebuild guard failed:[0m\n");
  for (const f of failures) console.error(`  • ${f}\n`);
  process.exit(1);
}

// Lightweight success log — visible in Vercel build output without being noisy.
console.log(
  `prebuild-guards OK ` +
    `(VERCEL_ENV=${VERCEL_ENV || "<unset>"}, ` +
    `VITE_DEMO_MODE=${DEMO_MODE}, VITE_USE_SUPABASE=${USE_SUPABASE})`,
);
