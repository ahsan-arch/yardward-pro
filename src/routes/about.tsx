import { createFileRoute } from "@tanstack/react-router";
import heroAsset from "@/assets/skyhigh-hero.jpg.asset.json";

export const Route = createFileRoute("/about")({
  component: AboutPage,
  head: () => ({
    meta: [
      { title: "About — Sky High Luxury Vapes" },
      {
        name: "description",
        content:
          "The Sky High story: luxury disposable vapes inspired by destinations and crafted for first-class flavour.",
      },
    ],
  }),
});

function AboutPage() {
  return (
    <div>
      <section className="relative overflow-hidden">
        <img
          src={heroAsset.url}
          alt=""
          className="absolute inset-0 w-full h-full object-cover opacity-30"
        />
        <div className="absolute inset-0 bg-gradient-to-b from-navy/60 to-navy" />
        <div className="relative max-w-3xl mx-auto px-4 py-24 text-center">
          <h1 className="font-serif text-5xl text-amber-brand">Our Story</h1>
          <p className="mt-4 text-amber-brand/80 text-lg">
            Sky High was born from a single idea — that a vape can be more than a device.
          </p>
        </div>
      </section>

      <section className="max-w-3xl mx-auto px-4 py-16 space-y-8 text-amber-brand/80 leading-relaxed">
        <p>
          Every Sky High flavour is named after a destination — a city, an island, a feeling. From
          the strawberry-mojito buzz of <em>Barcelona</em> to the cool apple-mint clarity of{" "}
          <em>Zürich</em>, our collection is a passport to taste.
        </p>
        <p>
          Our devices are engineered for the long-haul: a 5000-puff capacity, USB-C rechargeable
          batteries, and mesh-coil tech that keeps every draw as smooth as the first. The packaging
          is hand-finished with gold-foil detailing because we believe luxury lives in the small
          things.
        </p>
        <p>
          Sky High is for the modern traveller — those who want their everyday rituals to feel like
          an upgrade to first class.
        </p>

        <div className="border-t border-amber-brand/20 pt-8 mt-8">
          <h2 className="font-serif text-2xl text-amber-brand mb-3">Important notice</h2>
          <p className="text-sm opacity-70">
            Sky High products contain nicotine. Nicotine is an addictive chemical. Not for sale to
            minors. Intended for adults of legal smoking age (21+). Not for use by pregnant or
            breastfeeding women, or persons with or at risk of heart disease, high blood pressure,
            diabetes, or taking medicine for depression or asthma.
          </p>
        </div>
      </section>
    </div>
  );
}