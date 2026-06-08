import { createFileRoute, Link, notFound } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { Loader2, Check } from "lucide-react";
import { toast } from "sonner";
import {
  PRODUCT_BY_HANDLE_QUERY,
  storefrontApiRequest,
  type ShopifyProduct,
  formatPrice,
} from "@/lib/shopify";
import { useCartStore } from "@/stores/cartStore";

const searchSchema = z.object({
  variant: z.string().optional(),
});

export const Route = createFileRoute("/product/$handle")({
  validateSearch: (s) => searchSchema.parse(s),
  component: ProductPage,
  head: ({ params }) => ({
    meta: [
      { title: `${prettify(params.handle)} — Sky High` },
      {
        name: "description",
        content: "Premium Sky High disposable vape — pick your flavour and add to cart.",
      },
    ],
  }),
});

function prettify(handle: string) {
  return handle
    .split("-")
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(" ");
}

async function fetchProduct(handle: string): Promise<ShopifyProduct["node"] | null> {
  const data = await storefrontApiRequest(PRODUCT_BY_HANDLE_QUERY, { handle });
  return data?.data?.product ?? null;
}

function ProductPage() {
  const { handle } = Route.useParams();
  const { variant: variantFromUrl } = Route.useSearch();
  const { data: product, isLoading } = useQuery({
    queryKey: ["product", handle],
    queryFn: () => fetchProduct(handle),
  });

  const addItem = useCartStore((s) => s.addItem);
  const isAdding = useCartStore((s) => s.isLoading);

  const variants = product?.variants.edges ?? [];
  const initialVariantId =
    variantFromUrl && variants.find((v) => v.node.id === variantFromUrl)
      ? variantFromUrl
      : variants[0]?.node.id;
  const [selectedId, setSelectedId] = useState<string | undefined>(initialVariantId);

  // Sync when variants list arrives after first render
  if (selectedId === undefined && initialVariantId) {
    setSelectedId(initialVariantId);
  }

  if (isLoading) {
    return (
      <div className="max-w-6xl mx-auto px-4 py-20 text-center text-amber-brand/70">
        <Loader2 className="h-6 w-6 animate-spin mx-auto" />
      </div>
    );
  }
  if (!product) throw notFound();

  const selected = variants.find((v) => v.node.id === selectedId)?.node ?? variants[0]?.node;
  const images = product.images.edges;
  const selectedIndex = variants.findIndex((v) => v.node.id === selected?.id);
  const heroImage = images[selectedIndex]?.node ?? images[0]?.node;

  const handleAdd = async () => {
    if (!selected) return;
    await addItem({
      product: { node: product } as ShopifyProduct,
      variantId: selected.id,
      variantTitle: selected.title,
      price: selected.price,
      quantity: 1,
      selectedOptions: selected.selectedOptions,
    });
    toast.success("Added to your manifest", {
      description: selected.selectedOptions[0]?.value ?? selected.title,
    });
  };

  return (
    <div className="max-w-6xl mx-auto px-4 py-12">
      <Link
        to="/shop"
        className="text-xs uppercase tracking-widest text-amber-brand/60 hover:text-amber-brand"
      >
        ← Back to shop
      </Link>

      <div className="mt-6 grid gap-10 md:grid-cols-2">
        {/* Gallery */}
        <div>
          <div className="aspect-[3/4] rounded-lg overflow-hidden bg-black border border-amber-brand/20">
            {heroImage && (
              <img
                src={heroImage.url}
                alt={heroImage.altText ?? product.title}
                className="w-full h-full object-cover"
              />
            )}
          </div>
          {images.length > 1 && (
            <div className="mt-3 grid grid-cols-5 gap-2">
              {variants.map((v, i) => {
                const img = images[i]?.node ?? images[0]?.node;
                const isActive = v.node.id === selected?.id;
                return (
                  <button
                    key={v.node.id}
                    onClick={() => setSelectedId(v.node.id)}
                    className={`aspect-[3/4] rounded-md overflow-hidden border-2 transition ${
                      isActive ? "border-amber-brand" : "border-amber-brand/20 hover:border-amber-brand/50"
                    }`}
                  >
                    {img && <img src={img.url} alt="" className="w-full h-full object-cover" />}
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* Details */}
        <div>
          <div className="text-xs uppercase tracking-[0.3em] text-amber-brand/60">Sky High</div>
          <h1 className="font-serif text-4xl text-amber-brand mt-1">{product.title}</h1>

          {selected && (
            <div className="mt-4 text-3xl font-semibold text-amber-brand">
              {formatPrice(selected.price.amount, selected.price.currencyCode)}
            </div>
          )}

          <div
            className="mt-6 prose prose-invert prose-sm max-w-none text-amber-brand/80 [&_strong]:text-amber-brand [&_em]:text-amber-brand"
            dangerouslySetInnerHTML={{ __html: product.description }}
          />

          <div className="mt-8">
            <div className="text-xs uppercase tracking-widest text-amber-brand/60 mb-3">
              Choose your destination
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {variants.map((v) => {
                const isActive = v.node.id === selected?.id;
                const label = v.node.selectedOptions[0]?.value ?? v.node.title;
                return (
                  <button
                    key={v.node.id}
                    onClick={() => setSelectedId(v.node.id)}
                    disabled={!v.node.availableForSale}
                    className={`text-left px-4 py-3 rounded-md border transition flex items-center justify-between ${
                      isActive
                        ? "border-amber-brand bg-amber-brand/10"
                        : "border-amber-brand/20 hover:border-amber-brand/50"
                    } ${!v.node.availableForSale ? "opacity-40 cursor-not-allowed" : ""}`}
                  >
                    <span className="text-amber-brand text-sm">{label}</span>
                    {isActive && <Check className="h-4 w-4 text-amber-brand" />}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="mt-8 flex gap-3">
            <Button
              onClick={handleAdd}
              disabled={!selected || isAdding}
              size="lg"
              className="flex-1 bg-amber-brand text-navy hover:bg-amber-brand/90 font-semibold"
            >
              {isAdding ? <Loader2 className="h-4 w-4 animate-spin" /> : "Add to Cart"}
            </Button>
          </div>

          <ul className="mt-8 text-sm text-amber-brand/70 space-y-2 border-t border-amber-brand/10 pt-6">
            <li>· 5000+ puffs per device</li>
            <li>· 5% nicotine salt</li>
            <li>· USB-C rechargeable</li>
            <li>· Discreet, fast shipping</li>
          </ul>
        </div>
      </div>
    </div>
  );
}