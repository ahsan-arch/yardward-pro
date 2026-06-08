import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import {
  PRODUCTS_QUERY,
  storefrontApiRequest,
  type ShopifyProduct,
  formatPrice,
} from "@/lib/shopify";

export const Route = createFileRoute("/shop")({
  component: ShopPage,
  head: () => ({
    meta: [
      { title: "Shop — Sky High Luxury Vapes" },
      {
        name: "description",
        content:
          "Browse the full Sky High collection of premium disposable vapes — every flavour, every destination.",
      },
    ],
  }),
});

async function fetchProducts(): Promise<ShopifyProduct[]> {
  const data = await storefrontApiRequest(PRODUCTS_QUERY, { first: 50, query: null });
  return data?.data?.products?.edges ?? [];
}

function ShopPage() {
  const { data: products = [], isLoading } = useQuery({
    queryKey: ["products", "shop"],
    queryFn: fetchProducts,
  });

  // Flatten one card per variant for a true catalog view.
  const cards = products.flatMap((p) =>
    p.node.variants.edges.map((v, i) => ({
      product: p,
      variant: v.node,
      image: p.node.images.edges[i]?.node ?? p.node.images.edges[0]?.node,
    })),
  );

  return (
    <div className="max-w-6xl mx-auto px-4 py-16">
      <div className="text-center mb-12">
        <div className="text-[10px] uppercase tracking-[0.4em] text-amber-brand/60 mb-2">
          The Collection
        </div>
        <h1 className="font-serif text-5xl text-amber-brand">All Destinations</h1>
        <p className="mt-3 text-amber-brand/70 max-w-xl mx-auto">
          Pick your next flight.
        </p>
      </div>

      {isLoading ? (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-6">
          {Array.from({ length: 8 }).map((_, i) => (
            <div
              key={i}
              className="aspect-[3/4] rounded-md bg-amber-brand/5 border border-amber-brand/10 animate-pulse"
            />
          ))}
        </div>
      ) : cards.length === 0 ? (
        <div className="text-center py-20 border border-amber-brand/20 rounded-md">
          <p className="text-amber-brand/70">No products found.</p>
        </div>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-6">
          {cards.map(({ product, variant, image }) => (
            <Link
              key={variant.id}
              to="/product/$handle"
              params={{ handle: product.node.handle }}
              search={{ variant: variant.id }}
              className="group block border border-amber-brand/20 rounded-lg overflow-hidden bg-navy hover:border-amber-brand transition"
            >
              <div className="aspect-[3/4] bg-black overflow-hidden">
                {image && (
                  <img
                    src={image.url}
                    alt={image.altText ?? variant.title}
                    className="w-full h-full object-cover group-hover:scale-105 transition duration-500"
                    loading="lazy"
                  />
                )}
              </div>
              <div className="p-4">
                <div className="text-xs uppercase tracking-widest text-amber-brand/50">
                  Sky High
                </div>
                <div className="mt-1 font-serif text-lg text-amber-brand line-clamp-2">
                  {variant.selectedOptions[0]?.value ?? variant.title}
                </div>
                <div className="mt-2 text-amber-brand font-semibold">
                  {formatPrice(variant.price.amount, variant.price.currencyCode)}
                </div>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}