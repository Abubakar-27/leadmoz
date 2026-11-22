"use client";

import { FlowButton } from "@/components/ui/flow-button";
import { Badge } from "@/components/ui/badge";
import { HeroShutterText } from "@/components/ui/hero-shutter-text";
import { ArrowRightIcon } from "lucide-react";
import { Mockup, MockupFrame } from "@/components/ui/mockup";
import { Glow } from "@/components/ui/glow";
import Image from "next/image";
import { useTheme } from "next-themes";
import { motion } from "framer-motion";
import { cn } from "@/lib/utils";

interface HeroAction {
  text: string;
  href: string;
  icon?: React.ReactNode;
  variant?: "default" | "glow" | "outline";
}

interface HeroProps {
  badge?: {
    text: string;
    action: {
      text: string;
      href: string;
    };
  };
  /** Plain heading when only one line is used. */
  title?: string;
  /** Optional list of heading lines cycled by the shutter effect. */
  titles?: string[];
  /** Key words inside the shutter lines rendered in the accent color. */
  highlights?: string[];
  description: string;
  actions: HeroAction[];
  /** Optional ready-made product mock rendered inside the Mockup frame. */
  tour?: React.ReactNode;
  image?: {
    light: string;
    dark: string;
    alt: string;
  };
}

export function HeroSection({
  badge,
  title,
  titles,
  highlights,
  description,
  actions,
  tour,
  image,
}: HeroProps) {
  const { resolvedTheme } = useTheme();
  const imageSrc = image
    ? resolvedTheme === "light"
      ? image.light
      : image.dark
    : undefined;

  /*
    Ambient gradient: no pointer input at all — the halo wanders on its
    own on a slow infinite loop (position + slight breathing), so the
    page feels alive on load.
  */
  return (
    <section
      className={cn(
        "bg-background text-foreground",
        "py-12 sm:py-24 md:py-32 px-4",
        "fade-bottom overflow-hidden pb-0"
      )}
    >
      <div className="relative z-10 mx-auto flex max-w-container flex-col gap-12 pt-16 sm:gap-24">
        <div className="flex flex-col items-center gap-6 text-center sm:gap-12">
          {/* Badge */}
          {badge && (
            <Badge variant="outline" className="animate-appear gap-2">
              <span className="text-muted-foreground">{badge.text}</span>
              <a href={badge.action.href} className="flex items-center gap-1">
                {badge.action.text}
                <ArrowRightIcon className="h-3 w-3" />
              </a>
            </Badge>
          )}

          {/* Title — shutter effect when multiple lines are provided */}
          <HeroShutterText
            texts={titles ?? [title ?? ""]}
            highlights={highlights ?? []}
            className="animate-appear"
          />

          {/* Description */}
          <p className="text-md relative z-10 max-w-[550px] animate-appear font-medium text-muted-foreground opacity-0 delay-100 sm:text-xl">
            {description}
          </p>

          {/* Actions */}
          <div className="relative z-10 flex animate-appear justify-center gap-4 opacity-0 delay-300">
            <div className="relative z-10 flex animate-appear justify-center gap-4 opacity-0 delay-300">
              {actions.map((action, index) => (
                <FlowButton
                  key={index}
                  text={action.text}
                  href={action.href}
                  icon={action.icon}
                  variant={action.variant === "outline" ? "outline" : "primary"}
                />
              ))}
            </div>
          </div>

          {/* Image with Glow */}
          <div className="relative pt-12">
            <MockupFrame
              className="animate-appear opacity-0 delay-700"
              size="small"
            >
              <Mockup type="responsive">
                {tour ?? (
                  <Image
                    src={imageSrc!}
                    alt={image!.alt}
                    width={1248}
                    height={765}
                    priority
                  />
                )}
              </Mockup>
            </MockupFrame>
            {/* Glow roams the whole hero on its own, no pointer input */}
            <motion.div
              aria-hidden
              animate={{
                x: [0, -480, 380, -40, 460, 0],
                y: [0, -320, -160, 90, 260, 0],
                scale: [1, 1.15, 0.92, 1.22, 0.88, 1],
              }}
              transition={{
                duration: 24,
                repeat: Infinity,
                ease: "easeInOut",
              }}
              className="absolute inset-0 z-0"
            >
              <Glow
                variant="top"
                className="animate-appear-zoom opacity-0 delay-1000"
              />
            </motion.div>
          </div>
        </div>
      </div>
    </section>
  );
}
