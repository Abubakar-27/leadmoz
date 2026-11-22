import assert from "node:assert/strict";
import { locationEvidence } from "../src/advancedVerifier.js";

let pass = 0;
function checkAsync(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      pass++;
      console.log("ok - " + name);
    })
    .catch((err) => {
      console.log("NOT OK - " + name);
      console.log("  " + err.message);
      process.exitCode = 1;
    });
}

/*
  A "mexico" search must not be satisfied by "New Mexico", and a business
  domain or name that happens to contain the word is not proof of location.
  These are the two real leads that were saved and marked verified by mistake:
  a Santa Fe, New Mexico shop (area code 505) and a "Mexico Auto Repair LLC"
  in Washington state (area code 253).
*/
await checkAsync('"New Mexico" in the address does not satisfy a "mexico" search', () => {
  const scraped = {
    businessName: "Executive Automotive Santa Fe: Foreign Car Repair",
    title: "Foreign Car Repair in Santa Fe, NM",
    description: "Family owned auto repair serving northern New Mexico since 1994.",
    text: "Located at 1234 Calle Principal, Santa Fe, New Mexico 87501. We serve the whole New Mexico region.",
    addresses: ["1234 Calle Principal, Santa Fe, New Mexico 87501"],
    website: "https://executiveautomotivesantafe.com/",
    pagesScraped: ["Contact", "About"]
  };

  const evidence = locationEvidence(scraped, "mexico");
  assert.notEqual(evidence, "strong", 'New Mexico was accepted as strong evidence for "mexico"');
});

await checkAsync('a domain containing "mexico" is not location evidence', () => {
  const scraped = {
    businessName: "Mexico Auto Repair LLC",
    title: "Mexico Auto Repair LLC",
    description: "Full service auto repair.",
    text: "Family owned shop serving the Puget Sound area since 2004.",
    addresses: ["2201 S 56th St, Tacoma, WA 98408"],
    website: "https://mexicoautorepairllc.com/contact",
    pagesScraped: ["About"]
  };

  const evidence = locationEvidence(scraped, "mexico");
  assert.notEqual(evidence, "strong", 'the website string alone satisfied "mexico"');
});

await checkAsync('a real Mexico address still matches "mexico"', () => {
  const scraped = {
    businessName: "Taller Mecanico Ruiz",
    title: "Taller Mecanico Ruiz - Mexico DF",
    description: "Servicio de mecanica automata en la Ciudad de Mexico.",
    text: "Visitas: Av. Insurgentes Sur 1602, Credito Constructor, Ciudad de Mexico, CDMX, 03940.",
    addresses: ["Av. Insurgentes Sur 1602, Ciudad de Mexico, CDMX 03940"],
    website: "https://tallermecanicoruiz.mx/",
    pagesScraped: ["Contacto"]
  };

  assert.equal(locationEvidence(scraped, "mexico"), "strong", "a genuine Mexico address was rejected");
});

await checkAsync('"New Mexico" still matches a "new mexico" search', () => {
  const scraped = {
    businessName: "Desert Auto Works",
    title: "Auto repair in Albuquerque",
    description: "Serving New Mexico since 2001.",
    text: "4200 Central Ave SE, Albuquerque, New Mexico 87108.",
    addresses: ["4200 Central Ave SE, Albuquerque, New Mexico 87108"],
    pagesScraped: ["Contact"]
  };

  assert.equal(locationEvidence(scraped, "new mexico"), "strong", '"new mexico" no longer matches itself');
});

await checkAsync('"mexico" alongside a real Mexico mention still matches', () => {
  const scraped = {
    businessName: "Auto Service Guadalajara",
    title: "Auto service in Guadalajara, Mexico",
    description: "Mecanica y electrica.",
    text: "Av. Vallarta 1234, Guadalajara, Jalisco, Mexico.",
    addresses: ["Av. Vallarta 1234, Guadalajara, Jalisco, Mexico"],
    pagesScraped: ["Contacto"]
  };

  assert.equal(locationEvidence(scraped, "mexico"), "strong", "a genuine Mexico mention was rejected");
});

console.log(`\n${pass} location-conflict checks passed`);
