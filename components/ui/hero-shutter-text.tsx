"use client";

import React, { useEffect, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { cn } from "@/lib/utils";

/*
  "Shutter" heading, adapted from the full-screen HeroText component:
  every character reveals with a blur-in plus three clipped slices that
  sweep across it. The lines cycle automatically on a fixed interval
  (default 5s); no user control needed.

  Rendered as an <h1> with real text for SEO; the server and the first
  client render both start at index 0, so hydration matches.
*/

interface HeroShutterTextProps {
  /** Lines to cycle through on the interval. */
  texts: string[];
  /** Substrings to render in the accent color (the key words). */
  highlights?: string[];
  /** Milliseconds each line stays on screen. */
  intervalMs?: number;
  className?: string;
}

export function HeroShutterText({
  texts,
  highlights = [],
  intervalMs = 5000,
  className = "",
}: HeroShutterTextProps) {
  const [count, setCount] = useState(0);
  const cycle = texts.length > 0 ? texts : ["IMMERSE"];
  const text = cycle[count % cycle.length] ?? cycle[0] ?? "";
  const characters = text.split("");

  /*
    Which characters are part of the highlighted key words? Matched
    case-insensitively; overlapping/any number of occurrences both work.
  */
  const accent = new Array<boolean>(text.length).fill(false);
  for (const word of highlights) {
    if (!word) continue;
    const hay = text.toLowerCase();
    const needle = word.toLowerCase();
    let idx = hay.indexOf(needle);
    while (idx !== -1) {
      for (let k = idx; k < idx + needle.length; k++) accent[k] = true;
      idx = hay.indexOf(needle, idx + needle.length);
    }
  }

  /*
    Auto-cycle. One interval tick per line; the shutter animation for the
    longest line finishes well inside the default 3s window.
  */
  useEffect(() => {
    const id = setInterval(() => setCount((c) => c + 1), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);

  return (
    <div className={cn("relative w-full select-none px-4", className)}>
      {/* Heading */}
      <h1 className="relative z-10 flex w-full flex-wrap items-center justify-center text-center">
        <AnimatePresence mode="wait">
          <motion.div
            key={count}
            className="flex flex-wrap items-center justify-center"
          >
            {characters.map((char, i) => (
              <div
                key={`${count}-${i}`}
                className="group relative overflow-hidden px-[0.1vw]"
              >
                {/* Main character — blur-in stagger */}
                <motion.span
                  initial={{ opacity: 0, filter: "blur(10px)" }}
                  animate={{ opacity: 1, filter: "blur(0px)" }}
                  transition={{ delay: i * 0.04 + 0.3, duration: 0.8 }}
                  className={cn(
                    "font-display text-[clamp(2.25rem,6vw,4.5rem)] font-black leading-[1.05] tracking-tighter",
                    accent[i] ? "text-primary" : "text-foreground",
                  )}
                >
                  {char === " " ? "\u00A0" : char}
                </motion.span>

                {/* Top slice */}
                <motion.span
                  aria-hidden
                  initial={{ x: "-100%", opacity: 0 }}
                  animate={{ x: "100%", opacity: [0, 1, 0] }}
                  transition={{
                    duration: 0.7,
                    delay: i * 0.04,
                    ease: "easeInOut",
                  }}
                  className="pointer-events-none absolute inset-0 z-10 font-display text-[clamp(2.25rem,6vw,4.5rem)] font-black leading-[1.05] tracking-tighter text-primary"
                  style={{ clipPath: "polygon(0 0, 100% 0, 100% 35%, 0 35%)" }}
                >
                  {char}
                </motion.span>

                {/* Middle slice */}
                <motion.span
                  aria-hidden
                  initial={{ x: "100%", opacity: 0 }}
                  animate={{ x: "-100%", opacity: [0, 1, 0] }}
                  transition={{
                    duration: 0.7,
                    delay: i * 0.04 + 0.1,
                    ease: "easeInOut",
                  }}
                  className="pointer-events-none absolute inset-0 z-10 font-display text-[clamp(2.25rem,6vw,4.5rem)] font-black leading-[1.05] tracking-tighter text-foreground/70"
                  style={{
                    clipPath: "polygon(0 35%, 100% 35%, 100% 65%, 0 65%)",
                  }}
                >
                  {char}
                </motion.span>

                {/* Bottom slice */}
                <motion.span
                  aria-hidden
                  initial={{ x: "-100%", opacity: 0 }}
                  animate={{ x: "100%", opacity: [0, 1, 0] }}
                  transition={{
                    duration: 0.7,
                    delay: i * 0.04 + 0.2,
                    ease: "easeInOut",
                  }}
                  className="pointer-events-none absolute inset-0 z-10 font-display text-[clamp(2.25rem,6vw,4.5rem)] font-black leading-[1.05] tracking-tighter text-primary"
                  style={{
                    clipPath: "polygon(0 65%, 100% 65%, 100% 100%, 0 100%)",
                  }}
                >
                  {char}
                </motion.span>
              </div>
            ))}
          </motion.div>
        </AnimatePresence>
      </h1>
    </div>
  );
}
