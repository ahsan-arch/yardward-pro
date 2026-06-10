// Engage Hydrovac Services brand mark — the square EHS logo used in the
// sidebar headers, login, and reset-password pages. Rendered inside a white
// rounded tile so the red/black mark stays legible on both the dark navy
// sidebar and light card backgrounds (the source art has a white field).
//
// Asset: /brand/ehs-mark.png (128px PNG generated from the high-res logo;
// favicon + PWA icons in /public are generated from the same source).

import { cn } from "@/lib/utils";

export function BrandMark({ size = "md", className }: { size?: "md" | "lg"; className?: string }) {
  return (
    <div
      className={cn(
        "rounded-md bg-white grid place-items-center overflow-hidden shrink-0 border border-black/10",
        size === "lg" ? "w-9 h-9" : "w-8 h-8",
        className,
      )}
    >
      <img
        src="/brand/ehs-mark.png"
        alt="Engage Hydrovac Services"
        className={size === "lg" ? "w-8 h-8" : "w-7 h-7"}
        draggable={false}
      />
    </div>
  );
}
