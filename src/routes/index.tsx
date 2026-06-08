import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import {
  PRODUCTS_QUERY,
  storefrontApiRequest,
  type ShopifyProduct,
  formatPrice,
} from "@/lib/shopify";
import heroAsset from "@/assets/skyhigh-hero.jpg.asset.json";

export const Route = createFileRoute("/")({
  component: HomePage,
  head: () => ({
    meta: [
      { title: "Sky High — Luxury Disposable Vapes" },
      {
        name: "description",
        content:
          "Ready for takeoff. Sky High premium disposable vapes — luxury flavours inspired by destinations around the world.",
      },
      { property: "og:image", content: heroAsset.url },
    ],
  }),
});

async function fetchProducts(): Promise<ShopifyProduct[]> {
  const data = await storefrontApiRequest(PRODUCTS_QUERY, { first: 12, query: null });
  return data?.data?.products?.edges ?? [];
}

function HomePage() {
  const { data: products = [], isLoading } = useQuery({
    queryKey: ["products"],
    queryFn: fetchProducts,
  });

  return (
    <div>
      {/* HERO */}
      <section className="relative overflow-hidden">
        <img
          src={heroAsset.url}
          alt=""
          className="absolute inset-0 w-full h-full object-cover opacity-50"
          width={1920}
          height={1080}
        />
        <div className="absolute inset-0 bg-gradient-to-b from-navy/40 via-navy/70 to-navy" />
        <div className="relative max-w-5xl mx-auto px-4 py-28 sm:py-40 text-center">
          <div className="inline-block text-[10px] uppercase tracking-[0.4em] text-amber-brand/80 border border-amber-brand/30 px-3 py-1 rounded-full mb-6">
            Sky High · Luxury Vapes
          </div>
          <h1 className="font-serif text-5xl sm:text-7xl font-light tracking-tight text-amber-brand">
            Ready for Takeoff
          </h1>
          <p className="mt-6 max-w-xl mx-auto text-amber-brand/80 text-lg">
            A first-class flight of flavour. Hand-crafted disposable vapes inspired by destinations
            across the globe.
          </p>
          <div className="mt-10 flex gap-4 justify-center">
            <Button
              asChild
              size="lg"
              className="bg-amber-brand text-navy hover:bg-amber-brand/90 font-semibold"
            >
              <Link to="/shop">Shop the Collection</Link>
            </Button>
            <Button
              asChild
              size="lg"
              variant="outline"
              className="border-amber-brand/40 bg-transparent text-amber-brand hover:bg-amber-brand/10"
            >
              <Link to="/about">Our Story</Link>
            </Button>
          </div>
        </div>
      </section>

      {/* COLLECTION */}
      <section className="max-w-6xl mx-auto px-4 py-20">
        <div className="text-center mb-12">
          <div className="text-[10px] uppercase tracking-[0.4em] text-amber-brand/60 mb-2">
            Abendflug Hybrid · 8,400 m
          </div>
          <h2 className="font-serif text-4xl sm:text-5xl text-amber-brand">The Evening Flight</h2>
          <p className="mt-3 text-amber-brand/70 max-w-xl mx-auto">
            Five destinations. One legendary night.
          </p>
        </div>

        {isLoading ? (
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-6">
            {Array.from({ length: 5 }).map((_, i) => (
              <div
                key={i}
                className="aspect-[2/3] rounded-md bg-amber-brand/5 border border-amber-brand/10 animate-pulse"
              />
            ))}
          </div>
        ) : products.length === 0 ? (
          <div className="text-center py-20 border border-amber-brand/20 rounded-md">
            <p className="text-amber-brand/70">No products found.</p>
          </div>
        ) : (
          <div className="grid gap-6">
            {products.map((p) => (
              <ProductHero key={p.node.id} product={p} />
            ))}
          </div>
        )}
      </section>

      {/* CRAFTSMANSHIP */}
      <section className="bg-gradient-to-b from-navy to-black/60 border-t border-amber-brand/10">
        <div className="max-w-5xl mx-auto px-4 py-20 grid gap-12 md:grid-cols-3 text-center">
          {[
            { title: "5000+ Puffs", body: "Long-haul flights, every device." },
            { title: "Mesh Coil", body: "Rich, consistent flavour from first to last draw." },
            { title: "USB-C Ready", body: "Rechargeable so you never run out mid-journey." },
          ].map((f) => (
            <div key={f.title}>
              <div className="font-serif text-2xl text-amber-brand">{f.title}</div>
              <p className="mt-2 text-sm text-amber-brand/70">{f.body}</p>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

function ProductHero({ product }: { product: ShopifyProduct }) {
  const variants = product.node.variants.edges;
  const images = product.node.images.edges;
  const minPrice = product.node.priceRange.minVariantPrice;

  return (
    <div className="border border-amber-brand/20 rounded-lg p-6 sm:p-10 bg-gradient-to-br from-navy to-black/40">
      <div className="flex flex-col lg:flex-row gap-8 lg:items-center">
        <div className="flex-1">
          <h3 className="font-serif text-3xl text-amber-brand">{product.node.title}</h3>
          <p className="mt-3 text-amber-brand/70 line-clamp-3">
            {product.node.description ||
              "Luxury disposable vape. Smooth hybrid blend, mesh coil, premium packaging."}
          </p>
          <p className="mt-4 text-2xl font-semibold text-amber-brand">
            From {formatPrice(minPrice.amount, minPrice.currencyCode)}
          </p>
          <div className="mt-6">
            <Button
              asChild
              className="bg-amber-brand text-navy hover:bg-amber-brand/90 font-semibold"
            >
              <Link to="/product/$handle" params={{ handle: product.node.handle }}>
                Choose Destination →
              </Link>
            </Button>
          </div>
        </div>
        <div className="flex-1 grid grid-cols-3 sm:grid-cols-5 gap-3">
          {variants.slice(0, 5).map((v, i) => {
            const img = images[i]?.node ?? images[0]?.node;
            const flavour = v.node.selectedOptions[0]?.value ?? v.node.title;
            return (
              <Link
                key={v.node.id}
                to="/product/$handle"
                params={{ handle: product.node.handle }}
                search={{ variant: v.node.id }}
                className="group"
              >
                <div className="aspect-[2/3] rounded-md overflow-hidden border border-amber-brand/20 bg-black group-hover:border-amber-brand transition">
                  {img && (
                    <img
                      src={img.url}
                      alt={img.altText ?? flavour}
                      className="w-full h-full object-cover group-hover:scale-105 transition"
                      loading="lazy"
                    />
                  )}
                </div>
                <div className="mt-2 text-xs text-center text-amber-brand/70 group-hover:text-amber-brand line-clamp-2">
                  {flavour}
                </div>
              </Link>
            );
          })}
        </div>
      </div>
    </div>
  );
}