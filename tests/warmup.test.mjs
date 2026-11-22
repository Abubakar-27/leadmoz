import { warmPreviewCache, breakerTrip, breakerReset, breakerOpen, runPreview } from "../src/preview.js";

let failures = 0;
const check = (name, cond, detail = "") => {
    if (cond) console.log(`  PASS  ${name}`);
    else { failures += 1; console.log(`  FAIL  ${name} ${detail}`); }
};

console.log("\n[1] The breaker trips and clears");
breakerReset();
check("starts closed", breakerOpen() === false);
breakerTrip();
check("one failure keeps it closed", breakerOpen() === false);
breakerTrip();
breakerTrip();
check("third failure opens it", breakerOpen() === true);

console.log("\n[2] Warming does nothing while the breaker is open");
const summary = await warmPreviewCache({ pairs: [{ niche: "barber", location: "austin" }], gapMs: 0 });
check("warm-up reports it stood down", summary.skipped === 1 && summary.warmed === 0, JSON.stringify(summary));
breakerReset();
check("breaker recloses on reset", breakerOpen() === false);

console.log("\n[3] Two warm-up passes cannot overlap");
/* A real search would be slow, so this only asserts the guard exists: the
   second call must decline rather than starting a second pass. */
const first = warmPreviewCache({ pairs: [{ niche: "dentist", location: "chicago" }], gapMs: 0 });
const second = await warmPreviewCache({ pairs: [{ niche: "plumber", location: "phoenix" }], gapMs: 0 });
check("second pass is refused", second.skipped === "already running", JSON.stringify(second));
await first;

console.log("\n[4] Warm-up does not touch visitor quota");
const quotaMod = await import("../src/preview.js");
const before = quotaMod.previewQuotaRemaining("203.0.113.55");
await warmPreviewCache({ pairs: [{ niche: "landscaper", location: "denver" }], gapMs: 0 });
const after = quotaMod.previewQuotaRemaining("203.0.113.55");
check("quota untouched by background work", before === after, `${before} -> ${after}`);

console.log(`\n${failures === 0 ? "ALL WARMER CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
