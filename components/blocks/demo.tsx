"use client"

import { HeroSection } from "@/components/blocks/hero-section"
import { HeroProductTour } from "@/components/blocks/product-tour"

export function HeroSectionDemo() {
  return (
    <HeroSection
      badge={{
        text: "Introducing our new components",
        action: {
          text: "Learn more",
          href: "/auth",
        },
      }}
      titles={[
        "Find verified business leads.",
        "Score them.",
        "Prepare outreach in minutes.",
      ]}
      highlights={["business leads", "score", "outreach"]}
      description="Leadmoz searches public websites, verifies contacts, scores lead quality, and generates outreach-ready emails, DMs, and call openers from one clean dashboard."
      actions={[
        {
          text: "Start for free",
          href: "/auth?plan=free",
          variant: "default",
        },
        {
          text: "Product tour",
          href: "/#workflow",
          variant: "outline",
        },
      ]}
      tour={<HeroProductTour />}
    />
  )
}
