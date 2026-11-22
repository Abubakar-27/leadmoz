"use client";

import React from "react";
import { cn } from "@/lib/utils";

/*
  Soft radial glow rendered behind the hero mockup. Purely decorative:
  aria-hidden, pointer-events-none, sits at z-0 under the frame's z-10.
  The hero drives its entrance with animate-appear-zoom + delay-1000
  passed through className.
*/

type GlowVariant = "top" | "below" | "sides";

interface GlowProps extends React.HTMLAttributes<HTMLDivElement> {
  variant?: GlowVariant;
}

const glowVariants: Record<GlowVariant, string> = {
  top: "left-1/2 top-0 -translate-x-1/2",
  below: "left-1/2 -bottom-24 -translate-x-1/2",
  sides: "left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2",
};

export function Glow({ variant = "top", className, ...props }: GlowProps) {
  return (
    <div
      aria-hidden
      className={cn("pointer-events-none absolute z-0", glowVariants[variant], className)}
      {...props}
    >
      <div className="h-[260px] w-[720px] max-w-[85vw] rounded-[100%] bg-brand/40 blur-[120px]" />
      <div className="absolute left-1/2 top-1/2 h-[140px] w-[360px] max-w-[60vw] -translate-x-1/2 -translate-y-1/2 rounded-[100%] bg-brand-foreground/30 blur-[80px]" />
    </div>
  );
}
