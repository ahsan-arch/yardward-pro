import type { QueryClient } from "@tanstack/react-query";
import { QueryClientProvider } from "@tanstack/react-query";
import {
  Outlet,
  createRootRouteWithContext,
  useRouter,
  HeadContent,
  Link,
} from "@tanstack/react-router";
import { Toaster } from "@/components/ui/sonner";
import { CartDrawer } from "@/components/CartDrawer";
import { useCartSync } from "@/hooks/useCartSync";
import logoAsset from "@/assets/skyhigh-logo.png.asset.json";

function NotFoundComponent() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-navy px-4 text-amber-brand">
      <div className="max-w-md text-center">
        <h1 className="text-7xl font-serif">404</h1>
        <p className="mt-2 text-sm opacity-70">This flight doesn't exist.</p>
        <Link
          to="/"
          className="inline-block mt-6 px-4 py-2 rounded-md bg-amber-brand text-navy text-sm font-medium"
        >
          Back to runway
        </Link>
      </div>
    </div>
  );
}

function ErrorComponent({ error, reset }: { error: Error; reset: () => void }) {
  const router = useRouter();
  return (
    <div className="flex min-h-screen items-center justify-center bg-navy px-4 text-amber-brand">
      <div className="max-w-md text-center">
        <h1 className="text-xl font-semibold">Something went wrong</h1>
        <p className="mt-2 text-sm opacity-70">{error.message}</p>
        <button
          onClick={() => {
            router.invalidate();
            reset();
          }}
          className="mt-4 px-4 py-2 rounded-md bg-amber-brand text-navy text-sm font-medium"
        >
          Try again
        </button>
      </div>
    </div>
  );
}

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  component: RootComponent,
  notFoundComponent: NotFoundComponent,
  errorComponent: ErrorComponent,
  head: () => ({
    meta: [
      { title: "Sky High — Luxury Disposable Vapes" },
      {
        name: "description",
        content:
          "Sky High premium disposable vapes. Hand-crafted flavours inspired by destinations around the world.",
      },
      { property: "og:title", content: "Sky High — Luxury Disposable Vapes" },
      {
        property: "og:description",
        content:
          "Sky High premium disposable vapes. Hand-crafted flavours inspired by destinations around the world.",
      },
    ],
  }),
});

function Header() {
  return (
    <header className="sticky top-0 z-40 bg-navy/90 backdrop-blur border-b border-amber-brand/20">
      <div className="max-w-6xl mx-auto px-4 h-16 flex items-center justify-between">
        <Link to="/" className="flex items-center gap-3 group">
          <img src={logoAsset.url} alt="Sky High" className="h-12 w-auto" />
          <div className="hidden sm:block">
            <div className="font-serif text-amber-brand text-xl tracking-widest leading-none">
              SKY HIGH
            </div>
            <div className="text-[10px] uppercase tracking-[0.3em] text-amber-brand/60">
              Luxury Vapes
            </div>
          </div>
        </Link>
        <nav className="flex items-center gap-1 sm:gap-6">
          <Link
            to="/"
            activeOptions={{ exact: true }}
            className="text-sm uppercase tracking-wider text-amber-brand/70 hover:text-amber-brand px-2"
            activeProps={{ className: "text-amber-brand" }}
          >
            Home
          </Link>
          <Link
            to="/shop"
            className="text-sm uppercase tracking-wider text-amber-brand/70 hover:text-amber-brand px-2"
            activeProps={{ className: "text-amber-brand" }}
          >
            Shop
          </Link>
          <Link
            to="/about"
            className="text-sm uppercase tracking-wider text-amber-brand/70 hover:text-amber-brand px-2 hidden sm:inline"
            activeProps={{ className: "text-amber-brand" }}
          >
            About
          </Link>
          <CartDrawer />
        </nav>
      </div>
    </header>
  );
}

function Footer() {
  return (
    <footer className="border-t border-amber-brand/20 bg-navy text-amber-brand/70">
      <div className="max-w-6xl mx-auto px-4 py-10 grid gap-6 md:grid-cols-3">
        <div>
          <div className="font-serif text-amber-brand text-lg tracking-widest">SKY HIGH</div>
          <p className="mt-2 text-sm opacity-80">
            Premium disposable vapes inspired by destinations around the world.
          </p>
        </div>
        <div className="text-sm">
          <div className="uppercase tracking-widest text-amber-brand mb-2 text-xs">Shop</div>
          <ul className="space-y-1">
            <li>
              <Link to="/shop" className="hover:text-amber-brand">
                All flavours
              </Link>
            </li>
            <li>
              <Link to="/about" className="hover:text-amber-brand">
                About Sky High
              </Link>
            </li>
          </ul>
        </div>
        <div className="text-sm">
          <div className="uppercase tracking-widest text-amber-brand mb-2 text-xs">Notice</div>
          <p className="text-xs opacity-70">
            Sky High products contain nicotine. Nicotine is an addictive substance. For sale to adults
            21+ only. Not for use by pregnant or breastfeeding women.
          </p>
        </div>
      </div>
      <div className="border-t border-amber-brand/10 py-4 text-center text-xs opacity-60">
        © {new Date().getFullYear()} Sky High. All rights reserved.
      </div>
    </footer>
  );
}

function AgeGate() {
  // Simple session-only age gate. Persisted in sessionStorage so it pops once per tab session.
  const KEY = "skyhigh-age-ok";
  const verified =
    typeof window !== "undefined" && window.sessionStorage.getItem(KEY) === "1";
  if (verified) return null;
  return (
    <div className="fixed inset-0 z-[100] bg-black/95 backdrop-blur flex items-center justify-center px-4">
      <div className="max-w-md w-full bg-navy border border-amber-brand/40 rounded-lg p-8 text-center text-amber-brand">
        <img src={logoAsset.url} alt="Sky High" className="h-20 mx-auto mb-4" />
        <h2 className="font-serif text-2xl mb-2">Are you 21 or older?</h2>
        <p className="text-sm opacity-70 mb-6">
          You must be of legal smoking age in your jurisdiction to enter this site. Sky High products
          contain nicotine.
        </p>
        <div className="flex gap-3 justify-center">
          <button
            onClick={() => {
              window.sessionStorage.setItem(KEY, "1");
              window.location.reload();
            }}
            className="px-6 py-2 bg-amber-brand text-navy font-semibold rounded-md hover:bg-amber-brand/90"
          >
            Yes, I am 21+
          </button>
          <a
            href="https://www.google.com"
            className="px-6 py-2 border border-amber-brand/40 text-amber-brand rounded-md hover:bg-amber-brand/10"
          >
            Exit
          </a>
        </div>
      </div>
    </div>
  );
}

function RootComponent() {
  useCartSync();
  const ctx = Route.useRouteContext();
  return (
    <QueryClientProvider client={ctx.queryClient}>
      <HeadContent />
      <div className="min-h-screen flex flex-col bg-navy text-amber-brand">
        <Header />
        <main className="flex-1">
          <Outlet />
        </main>
        <Footer />
      </div>
      <AgeGate />
      <Toaster position="top-center" theme="dark" />
    </QueryClientProvider>
  );
}