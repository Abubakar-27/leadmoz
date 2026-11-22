"use client";

import { ArrowRight } from "lucide-react";
import { cn } from "@/lib/utils";

/*
  "Flow" button animation, generalized from the pasted FlowButton:
    - pill (rounded-[100px]) that morphs to rounded-[12px] on hover
    - an expanding circle fills the button from the center
    - a left arrow flies in while the right arrow flies out
    - its label shifts right and the text turns white over the fill

  variant="outline" is the original pasted look (transparent pill, dark
  fill on hover). variant="primary" keeps the Leadmoz orange button with
  the same fill mechanic using a dark circle.

  Renders an <a> because hero actions navigate; use as a link-style CTA.
*/

type FlowVariant = "primary" | "outline";

interface FlowButtonProps
  extends React.AnchorHTMLAttributes<HTMLAnchorElement> {
  text: string;
  href: string;
  variant?: FlowVariant;
  icon?: React.ReactNode;
}

const variantClasses: Record<FlowVariant, string> = {
  primary:
    "border-primary bg-primary text-primary-foreground hover:border-transparent",
  outline:
    "border-foreground/40 bg-transparent text-foreground hover:border-transparent hover:text-background",
};

const circleClasses: Record<FlowVariant, string> = {
  primary: "bg-[#111111]",
  outline: "bg-foreground",
};

export function FlowButton({
  text,
  href,
  variant = "primary",
  icon,
  className,
  ...props
}: FlowButtonProps) {
  return (
    <a
      href={href}
      className={cn(
        "group relative flex cursor-pointer items-center gap-1 overflow-hidden rounded-[100px] border-[1.5px] px-8 py-3 text-sm font-semibold",
        "transition-all duration-[600ms] ease-[cubic-bezier(0.23,1,0.32,1)]",
        "hover:rounded-[12px] active:scale-[0.95]",
        variantClasses[variant],
        className,
      )}
      {...props}
    >
      {/* Left arrow (arr-2): flies in from off-canvas on hover */}
      <ArrowRight
        aria-hidden
        className="absolute left-[-25%] z-[9] h-4 w-4 fill-none stroke-current transition-all duration-[800ms] ease-[cubic-bezier(0.34,1.56,0.64,1)] group-hover:left-4"
      />

      {/* Label (+ optional leading icon), slides right on hover */}
      <span className="relative z-[1] flex -translate-x-3 items-center gap-2 transition-all duration-[800ms] ease-out group-hover:translate-x-3">
        {icon}
        {text}
      </span>

      {/* Expanding circle fill */}
      <span
        aria-hidden
        className={cn(
          "absolute left-1/2 top-1/2 h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-[50%] opacity-0",
          "transition-all duration-[800ms] ease-[cubic-bezier(0.19,1,0.22,1)]",
          "group-hover:h-[220px] group-hover:w-[220px] group-hover:opacity-100",
          circleClasses[variant],
        )}
      />

      {/* Right arrow (arr-1): flies out on hover */}
      <ArrowRight
        aria-hidden
        className="absolute right-4 z-[9] h-4 w-4 fill-none stroke-current transition-all duration-[800ms] ease-[cubic-bezier(0.34,1.56,0.64,1)] group-hover:right-[-25%]"
      />
    </a>
  );
}
