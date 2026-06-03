import { test, expect } from "@playwright/test";
import { loginAs, recordConsoleErrors, recordNetworkErrors } from "./helpers";

// One test per button. Covers the public + auth surface:
//   /login       — role pickers, submit, forgot link, theme toggle, request access
//   /t/$token    — landing continue + go-to-login (invalid state)
//   /            — root redirect (no buttons)
//   __root       — error boundary "Try again", 404 "Go home"
// Plus session-scoped pieces that don't have a public route:
//   logout button inside admin RoleSwitcher
//   PwaUpdateBanner reload (mocked subscribe)

test.describe("button audit: public + auth", () => {
  // ----------------------------------------------------------------
  // /login — Role: Admin (toggle)
  // ----------------------------------------------------------------
  test("/login Role: Admin toggles the email field to alex@fleetops.co", async ({ page }) => {
    const consoleErrors = recordConsoleErrors(page);
    await page.goto("/login");
    await page.locator("#password").waitFor({ state: "visible" });

    // Make sure we start from a non-admin so the click is observable.
    await page.getByRole("button", { name: "Driver", exact: false }).first().click();
    await expect(page.locator("#email")).toHaveValue("tom@fleetops.co");

    await page.getByRole("button", { name: "Admin", exact: false }).first().click();
    await expect(page.locator("#email")).toHaveValue("alex@fleetops.co");

    expect(consoleErrors, consoleErrors.join("\n")).toEqual([]);
  });

  // ----------------------------------------------------------------
  // /login — Role: Driver (toggle)
  // ----------------------------------------------------------------
  test("/login Role: Driver toggles the email field to tom@fleetops.co", async ({ page }) => {
    const consoleErrors = recordConsoleErrors(page);
    await page.goto("/login");
    await page.locator("#password").waitFor({ state: "visible" });

    await page.getByRole("button", { name: "Driver", exact: false }).first().click();
    await expect(page.locator("#email")).toHaveValue("tom@fleetops.co");

    expect(consoleErrors, consoleErrors.join("\n")).toEqual([]);
  });

  // ----------------------------------------------------------------
  // /login — Role: Mechanic (toggle)
  // ----------------------------------------------------------------
  test("/login Role: Mechanic toggles the email field to jamie@fleetops.co", async ({ page }) => {
    const consoleErrors = recordConsoleErrors(page);
    await page.goto("/login");
    await page.locator("#password").waitFor({ state: "visible" });

    await page.getByRole("button", { name: "Mechanic", exact: false }).first().click();
    await expect(page.locator("#email")).toHaveValue("jamie@fleetops.co");

    expect(consoleErrors, consoleErrors.join("\n")).toEqual([]);
  });

  // ----------------------------------------------------------------
  // /login — Sign in to FleetOps (submit-form, success path)
  // ----------------------------------------------------------------
  test("/login Sign in to FleetOps submits with valid creds and lands on /admin", async ({
    page,
  }) => {
    const networkErrors = recordNetworkErrors(page);
    await page.goto("/login");
    await page.locator("#password").waitFor({ state: "visible" });

    await page.getByRole("button", { name: "Admin", exact: false }).first().click();
    // The form is pre-seeded with admin creds but we re-assert to be defensive.
    await page.locator("#email").fill("alex@fleetops.co");
    await page.locator("#password").fill("demo1234");

    await page.getByRole("button", { name: /sign in to fleetops/i }).click();
    await page.waitForURL((url) => url.pathname.startsWith("/admin"), { timeout: 15_000 });
    await expect(page).toHaveURL(/\/admin/);

    // No login-error should be on the page after a successful sign-in.
    await expect(page.getByTestId("login-error")).toHaveCount(0);
    expect(networkErrors, networkErrors.join("\n")).toEqual([]);
  });

  // ----------------------------------------------------------------
  // /login — Sign in to FleetOps (submit-form, error path)
  // ----------------------------------------------------------------
  test("/login Sign in to FleetOps shows validation errors on invalid creds", async ({ page }) => {
    await page.goto("/login");
    await page.locator("#password").waitFor({ state: "visible" });

    // Wipe both fields so the client-side validators trip without going to the
    // network. This exercises the same error rendering path the form uses for
    // server-rejected creds.
    await page.locator("#email").fill("not-an-email");
    await page.locator("#password").fill("123"); // < 6 chars

    await page.getByRole("button", { name: /sign in to fleetops/i }).click();

    // We stay on /login and inline errors render.
    await expect(page).toHaveURL(/\/login/);
    await expect(page.getByText("Enter a valid email")).toBeVisible();
    await expect(page.getByText("Min 6 characters")).toBeVisible();
  });

  // ----------------------------------------------------------------
  // /login — Forgot? link (mutate-data; here it's a no-op placeholder
  // button but we still assert it exists, is clickable, and does not
  // navigate away from /login or surface an unhandled error.)
  // ----------------------------------------------------------------
  test("/login Forgot? is clickable and does not navigate away", async ({ page }) => {
    const consoleErrors = recordConsoleErrors(page);
    await page.goto("/login");
    await page.locator("#password").waitFor({ state: "visible" });

    const forgot = page.getByRole("button", { name: /forgot\??/i });
    await expect(forgot).toBeVisible();
    await forgot.click();

    // Forgot is currently a type=button placeholder — confirm it didn't
    // submit the form or hop routes.
    await expect(page).toHaveURL(/\/login/);
    expect(consoleErrors, consoleErrors.join("\n")).toEqual([]);
  });

  // ----------------------------------------------------------------
  // /login — Theme toggle (Moon/Sun icon button)
  // ----------------------------------------------------------------
  test("/login theme toggle flips the document dark class", async ({ page }) => {
    await page.goto("/login");
    await page.locator("#password").waitFor({ state: "visible" });

    const toggle = page
      .locator("button:has(svg.lucide-moon), button:has(svg.lucide-sun)")
      .first();
    await expect(toggle).toBeVisible();

    const before = await page.evaluate(() =>
      document.documentElement.classList.contains("dark"),
    );
    await toggle.click();

    await expect
      .poll(() =>
        page.evaluate(() => document.documentElement.classList.contains("dark")),
      )
      .toBe(!before);
  });

  // ----------------------------------------------------------------
  // /login — Request access (nav span)
  //
  // Currently rendered as a styled <span> (no href, no onClick). The
  // audit catalogues it as a nav target, so we assert it is at least
  // present + visible. If it gets a real handler later, swap this for
  // a navigation assertion.
  // ----------------------------------------------------------------
  test("/login Request access is present and visible", async ({ page }) => {
    await page.goto("/login");
    await page.locator("#password").waitFor({ state: "visible" });

    const requestAccess = page.locator("span", { hasText: "Request access" }).first();
    await expect(requestAccess).toBeVisible();
  });

  // ----------------------------------------------------------------
  // /t/$token — Continue (submit-form / scoped session start)
  //
  // Uses the seeded mock token tok_live_a1b2c3 (D-01, scopedTo=shift,
  // expires 2099) which is set up in src/data/mockData.ts. We assert
  // it validates, the Continue button starts the scoped session, and
  // we land on the driver scope target.
  // ----------------------------------------------------------------
  test("/t/$token Continue validates and starts the scoped driver session", async ({ page }) => {
    await page.goto("/t/tok_live_a1b2c3");

    const continueBtn = page.getByRole("button", { name: /^continue/i });
    await expect(continueBtn).toBeVisible({ timeout: 15_000 });

    await continueBtn.click();

    // shift-scope lands on /driver (catch-all). Other scopes redirect
    // to /driver/forms, /driver/work-order, /driver/tickets — we keep
    // this assertion broad so reseeding the mock token to another
    // scope doesn't break the audit.
    await page.waitForURL(/\/driver/, { timeout: 15_000 });
    await expect(page).toHaveURL(/\/driver/);

    // Session storage should now carry the scoped credential.
    const sessionToken = await page.evaluate(() =>
      sessionStorage.getItem("fo:driver-token"),
    );
    expect(sessionToken).toBe("tok_live_a1b2c3");
  });

  // ----------------------------------------------------------------
  // /t/$token — Go to login (invalid / used / expired)
  //
  // We use a non-existent token so the validator returns invalid and
  // the error card renders with the "Go to login" link.
  // ----------------------------------------------------------------
  test("/t/$token Go to login link routes back to /login on invalid token", async ({ page }) => {
    await page.goto("/t/tok_does_not_exist_xyz");

    const goLogin = page.getByRole("link", { name: /go to login/i });
    await expect(goLogin).toBeVisible({ timeout: 15_000 });

    await goLogin.click();
    await page.waitForURL(/\/login/, { timeout: 10_000 });
    await expect(page).toHaveURL(/\/login/);
  });

  // ----------------------------------------------------------------
  // / — root redirect. No buttons to click; assert the redirect.
  // ----------------------------------------------------------------
  test("/ unauthed redirects to /login", async ({ page }) => {
    await page.context().clearCookies();
    // Make sure we start without the legacy auth flags.
    await page.addInitScript(() => {
      try {
        localStorage.removeItem("fo:authed");
        localStorage.removeItem("fo:role");
      } catch {
        /* noop */
      }
    });
    await page.goto("/");
    await page.waitForURL(/\/login/, { timeout: 10_000 });
    await expect(page).toHaveURL(/\/login/);
  });

  // ----------------------------------------------------------------
  // __root — 404 "Go home" link.
  // ----------------------------------------------------------------
  test("__root 404 Go home link routes to /", async ({ page }) => {
    // Force a route that doesn't exist so TanStack Router renders the
    // notFoundComponent from __root.tsx.
    await page.goto("/this-route-definitely-does-not-exist-xyz");

    await expect(page.getByText("404")).toBeVisible();
    const goHome = page.getByRole("link", { name: /go home/i });
    await expect(goHome).toBeVisible();
    await goHome.click();

    // / itself redirects to /login (unauthed) or to a role dashboard, so
    // we just assert we left the 404 page.
    await page.waitForURL((url) => !url.pathname.startsWith("/this-route"), {
      timeout: 10_000,
    });
    await expect(page.getByText("404")).toHaveCount(0);
  });

  // ----------------------------------------------------------------
  // __root — Error boundary "Try again".
  //
  // The router-level ErrorComponent only renders if a route throws
  // during render. We force one by navigating to a dev-only debug
  // route (src/routes/debug.error-boundary-trigger.tsx) gated on
  // window.__fo_test_force_error so we get a deterministic throw.
  // After the fallback appears we clear the flag and click Try again
  // to verify the boundary actually recovers the route.
  // ----------------------------------------------------------------
  test("__root Try again error-boundary button recovers the route", async ({ page }) => {
    // Set the throw flag before any app code runs so the route component
    // throws on its first render.
    await page.addInitScript(() => {
      (window as unknown as { __fo_test_force_error?: boolean }).__fo_test_force_error = true;
    });

    await page.goto("/debug/error-boundary-trigger");

    const tryAgain = page.getByRole("button", { name: /try again/i });
    await expect(tryAgain).toBeVisible({ timeout: 10_000 });

    // Clear the flag so the next render of the route succeeds.
    await page.evaluate(() => {
      (window as unknown as { __fo_test_force_error?: boolean }).__fo_test_force_error = false;
    });

    await tryAgain.click();

    // After clicking Try again the router invalidates and re-renders;
    // we should land on the debug page's normal (non-throwing) content
    // and the Try again button should be gone.
    await expect(page.getByTestId("debug-error-boundary-trigger")).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.getByRole("button", { name: /try again/i })).toHaveCount(0);
  });

  // ----------------------------------------------------------------
  // RoleSwitcher (top chrome) — Logout button.
  //
  // Only visible inside an authed session, so we log in as admin first
  // and then click the LogOut icon button. We expect to be punted to
  // /login and the fo:authed flag cleared.
  // ----------------------------------------------------------------
  test("Logout from admin session clears auth and routes to /login", async ({ page }) => {
    await loginAs(page, "admin");
    await expect(page).toHaveURL(/\/admin/);

    // The logout button is the one rendering the lucide-log-out icon
    // inside the sticky RoleSwitcher bar.
    const logout = page.locator("button:has(svg.lucide-log-out)").first();
    await expect(logout).toBeVisible();
    await logout.click();

    await page.waitForURL(/\/login/, { timeout: 10_000 });
    await expect(page).toHaveURL(/\/login/);

    const authed = await page.evaluate(() => localStorage.getItem("fo:authed"));
    expect(authed).not.toBe("1");
  });

  // ----------------------------------------------------------------
  // PwaUpdateBanner — Reload button.
  //
  // The banner only renders when registerSW's onNeedRefresh fires. We
  // can't get a real waiting SW in dev (devOptions.enabled=false), so
  // src/lib/pwa-updater.ts exposes a dev-only window.__forcePwaUpdate
  // hook that flips needRefresh=true and notifies subscribers — the
  // same code path the real onNeedRefresh callback runs.
  //
  // Then we click Reload and verify applyUpdate ran. Since updateSW
  // is null in dev (no real registration), applyUpdate falls back to
  // window.location.reload(), which we stub to set a flag instead of
  // actually reloading the page.
  // ----------------------------------------------------------------
  test("PwaUpdateBanner Reload triggers applyUpdate when needRefresh fires", async ({ page }) => {
    // Stub window.location.reload so applyUpdate's terminal side-effect
    // becomes observable without actually tearing down the page.
    await page.addInitScript(() => {
      (window as unknown as { __applyUpdateCalled?: boolean }).__applyUpdateCalled = false;
      Object.defineProperty(window.location, "reload", {
        configurable: true,
        value: () => {
          (window as unknown as { __applyUpdateCalled?: boolean }).__applyUpdateCalled = true;
        },
      });
    });

    await page.goto("/login");
    await page.locator("#password").waitFor({ state: "visible" });

    // Drive the banner's needRefresh signal via the dev-only window hook
    // exposed by src/lib/pwa-updater.ts.
    const forced = await page.evaluate(() => {
      const fn = (window as unknown as { __forcePwaUpdate?: () => void }).__forcePwaUpdate;
      if (typeof fn !== "function") return false;
      fn();
      return true;
    });

    expect(forced, "window.__forcePwaUpdate must be exposed in dev builds").toBe(true);

    const banner = page.getByRole("status").filter({ hasText: /new version available/i });
    await expect(banner).toBeVisible({ timeout: 5_000 });

    const reload = banner.getByRole("button", { name: /^reload$/i });
    await expect(reload).toBeVisible();
    await reload.click();

    // Either applyUpdate's reload stub fired, or the button transitioned
    // to its loading state. Accept either as success.
    await expect
      .poll(
        async () =>
          (await page.evaluate(
            () => (window as unknown as { __applyUpdateCalled?: boolean }).__applyUpdateCalled,
          )) === true,
        { timeout: 5_000 },
      )
      .toBe(true);
  });
});
