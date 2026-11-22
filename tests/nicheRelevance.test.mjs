// Built from a real "barber / texas" job that returned 9 leads of which 5 were
// not barber shops. Every scraped fixture below is the real homepage copy.
import assert from "node:assert";
import { assessNiche, serviceProviderEvidence } from "../src/nicheCheck.js";
import { detectNonBusinessSite } from "../src/advancedVerifier.js";

const bad = [
  {
    label: "law firm whose surname is Barber",
    domain: "texasattorney.net",
    businessName: "The Barber Law Office",
    title: "Houston Estate Planning Lawyers | Houston, TX | The Barber Law Office",
    description: "Ensure your affairs are in order with help from The Barber Law Office of Houston, TX. From will & estate planning to Medicaid law help, call our firm today!",
    text: "Houston Estate Planning Lawyers Virtual Conferencing Available Click Here For Our Free Brochures Avvo Call For a NO-COST Assesment Of Your Needs! 281-464-LAWS Mon-Fri or by appointment HOME ABOUT US SERVICES MEDICAID LAW ESTATE PLANNING PROBATE LAW WEALTH PROTECTION WORKSHOPS SIGN UP VIDEOS BLOG FAQ SENIOR TEXANS AREAS WE SERVICE CONTACT FIND SAFE HARBOR WITH CHRIS BARBER. Estate Protection Asset Planning Probate Law Nursing Home medicaid qualification Christopher J Barber Attorney & Counselor-at-Law Wealth Protection Estate Planning Probate Serving Texas"
  },
  {
    label: "barber college, not a shop",
    domain: "barberlifeacademy.com",
    businessName: "Barber Life Academy",
    title: "Barber Life Academy | Home",
    description: "We pride ourselves on being the best barber college in the Houston Area. We teach every aspect a barber needs to become successful inside and outside the shop.",
    text: "Barber Life Academy Home About Our Programs Class A Barber Cosmetology to Barber Crossover Admissions and Enrollment Students Resources Gallery Blog Feed Barbershop: Swerve Cutz Contact More Barber Life Academy Helping students on their way towards becoming master barbers. Pre enroll Today Book A Campus Tour Online Barber Course Our Mission Statement We pride ourselves on being the best barber college in the Houston Area. We teach every aspect a barber needs to become successful inside and outside the shop. About Us We dont simply teach our students how to pass an exam, we help them master their craft and showcase it to the world"
  },
  {
    label: "dog groomer, not a human barber",
    domain: "thepetbarberhouston.com",
    businessName: "The Pet Barber Houston",
    title: "The Pet Barber Houston - The Pet Barber of Houston offers premier dog grooming for the special pet in your life.",
    description: "",
    text: "The Pet Barber Houston Skip to content Menu Home Our Services Gallery Contact Us Menu Home Our Services Gallery Contact Us We specialize in the art of fine grooming ABOUT US Owner and operator Paul Willis has been a dog groomer since 1998, grooming in Houston and New York. Paul attended The New York School of Dog Grooming. It has been his dream to open his own place and he made that dream come true in 2014. Our Services Make an appointment We will always make your pet look great! 713-393-7181 | Memorial 281-501-3400 | River Oaks 713-818-9093 | Galleria 737-425-2822 | Georgetown"
  },
  {
    label: "barbering blog and quiz site",
    domain: "bookofbarbering.com",
    businessName: "Book of Barbering",
    title: "Book Of Barbering - Men's Haircuts, Beard Styles & Grooming Guides",
    description: "Find the best men's haircuts, beard styles, and grooming guides. Step-by-step barber tips from a professional with 20+ years of experience.",
    text: "Book of Barbering Home Tools Expand Haircut Finder Quiz Barber Tip Calculator Beard Style Quiz Face Shape Detector Hair Loss Risk Quiz Haircuts Expand Short Long Medium Fade Haircut Boys Hairstyles Celebrity Styles Beards Grooming How To Barber Shops Expand barber shops USA Barber Shops UK Barber Shops Canada Barber Shops Australia & NZ Shop Search Toggle Menu Book of Barbering Search Find Your Next Haircut Explore haircut photos and know what to ask your barber. Browse Haircuts Not sure? Help Me Choose Free - 5 questions - No signup What catches your eye? Fades Short Hair Curly Hair"
  },
  {
    label: "ranked listicle of other businesses",
    domain: "mybesthouston.com",
    businessName: "My Best Houston",
    title: "My Best Houston - Find Top Businesses in Houston",
    description: "Find Top Businesses in Houston",
    text: "My Best Houston View all results The 16 Best Fortune Tellers in Houston The 16 Best Clubs in Houston, TX The 20 Best Cheap Window Replacement Services in Houston Restaurants The 16 Best Steak and Ale Restaurants in Houston, TX Shopping The 3 Best Payless Shoes in Houston, TX Fashion The 6 Best Diva Boutiques in Houston, TX Fashion The 2 Best Doc Martens in Houston, TX Restaurants The 16 Best Cuban Restaurants in Houston, Texas Restaurants The 16 Best Patio Restaurants in Houston Heights Business The 20 Best Glass Repair Services in Houston 1 2 3 197 Categories Animals Art Beauty Beverages Business Cuisine Education Employment"
  }
];

const good = [
  {
    label: "real barbershop with priced menu",
    domain: "cutthroatbarbers.com",
    businessName: "Cutthroat Barbers",
    title: "Best Barbershop in Houston, TX | Fades & Shaves | Cutthroat",
    description: "Houston",
    text: "top of page Home LOCATIONS Heights Montrose Washington Ave CAREERS CONTACT CANCELLATION POLICY BLOGS Shop More Barbershop in Houston, TX Book Now EXCELLENT Based on 551 reviews Services Services Menu Artisan Barbering & Supply Haircut------------- $45+ Our signature haircut service includes any type of fades or precision scissor work. Tailored to your head shape and style. Head Shave------------- $40+ Buzzcut------------- $30+ Uniform buzz cut includes one guard all around. Note: No fading included in this service. Beard Trim------------- $35+ Traditional straight razor shave"
  },
  {
    label: "real barbershop with locations and booking",
    domain: "bestbarbershoptx.com",
    businessName: "Best Barber Shop Houston",
    title: "Best Barber Shop Houston | Men Haircuts, Styling, & Grooming",
    description: "Experience expert haircuts, shaves, grooming, and modern styling in Houston & Sugar Land. Reviving the barbershop tradition with a modern touch.",
    text: "Skip to content Home About Us Services Gallery Contact Us Book Now Haircut & Shaves Your style starts here. Choose a location University Blvd 11929 University Blvd #1e, Sugar Land, TX 77479 Book New Territory 5846 New Territory Blvd, Sugar Land, TX 77479 Book Savoy Center 11246 S Wilcrest Dr Suite 180, Houston, TX 77099 Book Beechnut Complex 14639 beechnut St Houston, TX 77083 Book Our Story Who WE Are Welcome to BEST Barber Shop, where the art of grooming meets exceptional service."
  },
  {
    label: "real barbershop, JS-rendered so only the title is known",
    domain: "fadebarbershophtx.com",
    businessName: "Fade Barber Shop",
    title: "FADE | Haircut | Bear Trim | Head Shave | Houston | Fade Barber Shop",
    description: "By Houston, for Houston. Fade is where the classic barbershop experience meets a crisp modern twist.",
    text: ""
  }
];

let failures = 0;

for (const c of bad) {
  const a = assessNiche({ scraped: c, niche: "barber" });
  const ok = a.verdict === "reject";
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  reject  ${c.domain.padEnd(26)} ${a.verdict.padEnd(8)} ${a.reason}`);

  const gate = detectNonBusinessSite(c, { niche: "barber" });
  if (!gate.hardReject) {
    failures++;
    console.log(`FAIL  hardReject missing for ${c.domain}`);
  }
}

for (const c of good) {
  const a = assessNiche({ scraped: c, niche: "barber" });
  const svc = serviceProviderEvidence(c);
  const ok = a.verdict !== "reject";
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  keep    ${c.domain.padEnd(26)} ${a.verdict.padEnd(8)} service=${svc.score} ${a.reason}`);
}

// The same rules have to hold for an unrelated niche, otherwise they are just
// barber special cases. Nothing here mentions barbers at all.
const otherBad = [
  {
    label: "coffee directory",
    niche: "coffee shop",
    scraped: {
      businessName: "My Best Coffee",
      title: "My Best Coffee - Find Top Businesses in Austin",
      description: "",
      text: "My Best Coffee View all results The 16 Best Coffee Shops in Austin The 20 Best Cafes Downtown Austin The 3 Best Lattes in Austin TX Categories Beverages Cuisine Shopping 1 2 3 197"
    }
  },
  {
    label: "coffee roasting blog with tools",
    niche: "coffee shop",
    scraped: {
      businessName: "Roast Matcher",
      title: "Coffee Roast Guide - Roast Levels Explained",
      description: "Learn the difference between light and dark roast with our roast quiz.",
      text: "Roast Matcher Home Tools Roast Level Quiz Grind Size Calculator Ratio Calculator Beans Expand Light Dark Medium Single Origin How To How To Brew Guides Tips Blog Subscribe Explore roast profiles and know what to ask your roaster."
    }
  },
  {
    label: "law firm that happens to do coffee talk",
    niche: "coffee shop",
    scraped: {
      businessName: "Barber Coffee Law",
      title: "Coffee & Corporate Law | Houston Attorney",
      description: "Business law and estate planning services in Houston.",
      text: "Coffee & Corporate Law Home ABOUT US SERVICES Business Law Estate Planning Probate Law Our attorney advises small businesses. Call for a free consultation. Serving Texas."
    }
  }
];

const otherGood = [
  {
    label: "real coffee shop with menu and hours",
    niche: "coffee shop",
    scraped: {
      businessName: "Blue Oak Coffee",
      title: "Blue Oak Coffee | Espresso, Lattes & Pastries in Austin",
      description: "Small-batch coffee, espresso and pastries. Open daily 7am to 5pm.",
      text: "Blue Oak Coffee Home Menu Our Story Beans Contact Order Online Espresso----- $4 Latte----- $5.5 Cold Brew----- $5 Croissant----- $4 Our Story We opened in 2014 to serve single-origin coffee. Book a catering order or reserve a table. Walk-ins welcome. 1204 S Congress Ave, Austin, TX 78704 Open today 7am - 5pm"
    }
  }
];

for (const c of otherBad) {
  const a = assessNiche({ scraped: c.scraped, niche: c.niche });
  const ok = a.verdict === "reject";
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  reject  ${c.label.padEnd(40)} ${a.verdict.padEnd(8)} ${a.reason}`);
}

for (const c of otherGood) {
  const a = assessNiche({ scraped: c.scraped, niche: c.niche });
  const svc = serviceProviderEvidence(c.scraped);
  const ok = a.verdict !== "reject";
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  keep    ${c.label.padEnd(40)} ${a.verdict.padEnd(8)} service=${svc.score} ${a.reason}`);
}

// From a real "coffee shops / new york" job that returned 8 leads of which 3
// were editorial pages, not coffee shops. Real URLs, real copy.
const coffeeBad = [
  {
    label: "photographer's blog post",
    url: "https://meghanlynchphotography.com/best-coffee-shops-nyc/",
    businessName: "Best Coffee Shops NYC - Meghan Lynch Photography",
    title: "Best Coffee Shops NYC - Meghan Lynch Photography",
    description: "",
    text: "home about COUPLES BLOG CONTACT PROPOSALS TRAVEL MEGHAN LYNCH PHOTOGRAPHY TIMELESS IMAGERY IN A VIBRANT TRUE TO COLOR EDITING STYLE Inquire Best Coffee Shops NYC June 30, 2025 Hi, I'm MEGHAN. Welcome to the Meghan Lynch Photography blog."
  },
  {
    label: "personal coffee blog, city-guide path",
    url: "https://www.brian-coffee-spot.com/the-coffee-spot-guide-to/usa-canada/new-york-city/",
    businessName: "New York City | Brian's Coffee Spot",
    title: "New York City | Brian's Coffee Spot",
    description: "",
    text: "Brian's Coffee Spot Devoted to Coffee Home About About Brian's Coffee Spot About Me About Coffee Espresso Cafetiere Flat White/Latte/Cappuccino Filter Instant Links Thanks Posts Glossary Categories Comments Contact Map Shop Travel Spot City Guides United Kingdom Birmingham Brighton Hove Bristol Cardiff Chester Edinburg"
  },
  {
    label: "tourism bureau category page",
    url: "https://visitbuffalo.com/coffee-shops/",
    businessName: "A Guide to Buffalo, NY's Cafes & Coffee Shops",
    title: "A Guide to Buffalo, NY's Cafes & Coffee Shops",
    description: "",
    text: ""
  }
];

const coffeeGood = [
  {
    label: "real NYC coffee shop (root path)",
    url: "https://johnscoffeenyc.com/",
    businessName: "John's Coffee Shop",
    title: "John's Coffee Shop: Home",
    description: "",
    text: "Home About Menu Coffee House John has been roasting since 1998. Order Online Espresso $4 Latte $5.25 Cold Brew $5. Hours 7am-5pm. 451 7th Ave, New York, NY 10018. Book Now Walk-ins welcome."
  },
  {
    label: "real coffee shop with /contact path",
    url: "https://lecafecoffee.com/contact",
    businessName: "Le Cafe Coffee",
    title: "Le Cafe Coffee - Premium Coffee in New York City",
    description: "Premium coffee in New York City.",
    text: "Our Story Menu Locations Book a table. Espresso $3.50 Latte $6 Flat White $5.50 Hours 8am-6pm. 92 Rivington St, New York, NY 10002. Book Now."
  }
];

for (const c of coffeeBad) {
  const scraped = { website: c.url, url: c.url, scrapeOk: true, businessName: c.businessName, title: c.title, description: c.description, text: c.text };
  const a = assessNiche({ scraped, niche: "coffee shops" });
  const gate = detectNonBusinessSite(scraped, { niche: "coffee shops" });
  const ok = a.verdict === "reject" && gate.hardReject;
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  reject  ${c.label.padEnd(34)} ${a.verdict.padEnd(8)} ${a.reason}`);
}

for (const c of coffeeGood) {
  const scraped = { website: c.url, url: c.url, scrapeOk: true, businessName: c.businessName, title: c.title, description: c.description, text: c.text };
  const a = assessNiche({ scraped, niche: "coffee shops" });
  const ok = a.verdict !== "reject";
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  keep    ${c.label.padEnd(34)} ${a.verdict.padEnd(8)} ${a.reason}`);
}

if (failures) {
  console.log(`\n${failures} FAILURES`);
  process.exit(1);
}
console.log("\nALL NICHE RELEVANCE CHECKS PASSED");
