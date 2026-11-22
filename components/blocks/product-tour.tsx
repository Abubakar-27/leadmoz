/*
  Tailwind recreation of the Leadmoz product-tour mock that lives on the
  landing page (public/index1.html → #workflow .browser-frame). It renders
  inside the hero's Mockup instead of a stock screenshot, so the hero shows
  our own product UI. Colors come from the shadcn tokens, so it adapts to
  light/dark automatically — no theme-dependent image swap needed.
*/

const pipelineSteps = ["Search", "Scrape", "Verify", "Score", "Outreach"];
const activeSteps = 3; // Search, Scrape, Verify are done in the mock

const leads = [
  {
    business: "Goldberg Plumbing",
    email: "Found",
    emailTone: "brand",
    confidence: "91%",
    status: "Verified",
  },
  {
    business: "UrbanFix Services",
    email: "Found",
    emailTone: "brand",
    confidence: "84%",
    status: "Review",
  },
  {
    business: "Apex Roofing",
    email: "Missing",
    emailTone: "muted",
    confidence: "62%",
    status: "Needs Review",
  },
];

export function HeroProductTour() {
  return (
    <div className="w-full overflow-hidden bg-card text-card-foreground">
      {/* Browser chrome */}
      <div className="flex items-center gap-1.5 border-b border-border bg-muted px-3 py-2">
        <span className="h-2.5 w-2.5 rounded-full bg-border" />
        <span className="h-2.5 w-2.5 rounded-full bg-border" />
        <span className="h-2.5 w-2.5 rounded-full bg-border" />
      </div>

      <div className="space-y-4 p-4 text-left">
        {/* Job stats */}
        <div className="grid grid-cols-3 gap-2">
          {[
            { label: "Campaign", value: "Website Design Outreach" },
            { label: "Target", value: "Plumbers in Dallas" },
            { label: "Mode", value: "AI Outreach" },
          ].map((stat) => (
            <div key={stat.label} className="rounded-md bg-muted px-2.5 py-2">
              <span className="block text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                {stat.label}
              </span>
              <strong className="block truncate text-xs sm:text-sm">{stat.value}</strong>
            </div>
          ))}
        </div>

        {/* Pipeline */}
        <div className="flex flex-wrap gap-1.5">
          {pipelineSteps.map((step, index) => {
            const done = index < activeSteps;
            return (
              <span
                key={step}
                className={
                  done
                    ? "rounded-full bg-primary px-2.5 py-1 text-[10px] font-semibold text-primary-foreground sm:text-xs"
                    : "rounded-full bg-muted px-2.5 py-1 text-[10px] font-medium text-muted-foreground sm:text-xs"
                }
              >
                {step}
              </span>
            );
          })}
        </div>

        {/* Leads table */}
        <div className="overflow-hidden rounded-md border border-border">
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="bg-muted text-[10px] uppercase tracking-wide text-muted-foreground">
                <th className="px-2.5 py-2 font-medium sm:text-xs">Business</th>
                <th className="px-2.5 py-2 font-medium sm:text-xs">Email</th>
                <th className="hidden px-2.5 py-2 font-medium sm:table-cell sm:text-xs">Confidence</th>
                <th className="px-2.5 py-2 font-medium sm:text-xs">Status</th>
              </tr>
            </thead>
            <tbody>
              {leads.map((lead) => (
                <tr key={lead.business} className="border-t border-border">
                  <td className="px-2.5 py-2 font-medium">{lead.business}</td>
                  <td className="px-2.5 py-2">
                    <span
                      className={
                        lead.emailTone === "brand"
                          ? "inline-flex rounded-full bg-primary/15 px-2 py-0.5 text-[10px] font-semibold text-primary"
                          : "inline-flex rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground"
                      }
                    >
                      {lead.email}
                    </span>
                  </td>
                  <td className="hidden px-2.5 py-2 sm:table-cell">{lead.confidence}</td>
                  <td className="px-2.5 py-2">
                    <span className="inline-flex rounded-full border border-border px-2 py-0.5 text-[10px] font-medium">
                      {lead.status}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
