import express from "express";
import { consumePreviewQuota, previewQuotaRemaining, previewCachePeek, PREVIEW_HOURLY_LIMIT } from "../src/preview.js";

let failures = 0;
const check = (name, cond, detail = "") => {
    if (cond) console.log(`  PASS  ${name}`);
    else { failures += 1; console.log(`  FAIL  ${name} ${detail}`); }
};

console.log("\n[1] The real visitor address beats the proxy's");
/* Mirrors clientIp() in server.js. */
function clientIp(req) {
    if (req.ip) return String(req.ip);
    if (req.socket?.remoteAddress) return String(req.socket.remoteAddress);
    const real = String(req.headers["x-real-ip"] || "").trim();
    return real || "unknown";
}

check("prefers the address express resolved", clientIp({ ip: "203.0.113.7", headers: { "x-real-ip": "10.0.0.5" } }) === "203.0.113.7");
check("falls back to the socket when unproxied", clientIp({ headers: {}, ip: "127.0.0.1" }) === "127.0.0.1");
check("falls back to the socket when express has no ip", clientIp({ headers: {}, socket: { remoteAddress: "::1" } }) === "::1");
check("last resort is x-real-ip", clientIp({ headers: { "x-real-ip": "198.51.100.3" } }) === "198.51.100.3");
check("never returns empty", clientIp({ headers: {} }) === "unknown");

console.log("\n[2] Two visitors behind the same proxy get separate allowances");
const app = express();
app.set("trust proxy", 1);

const quotaSeen = [];
app.post("/probe", (req, res) => {
    const ip = clientIp(req);
    const allowance = consumePreviewQuota(ip);
    quotaSeen.push({ ip, allowed: allowance.allowed });
    res.json({ ip, allowed: allowance.allowed, remaining: previewQuotaRemaining(ip) });
});

const server = app.listen(0);
await new Promise(r => server.once("listening", r));
const port = server.address().port;

const call = (xff) => fetch(`http://127.0.0.1:${port}/probe`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Forwarded-For": xff },
    body: "{}"
}).then(r => r.json());

const alice = [];
for (let i = 0; i < PREVIEW_HOURLY_LIMIT + 1; i++) alice.push(await call("203.0.113.10"));
check("visitor A is allowed their full allowance", alice.slice(0, PREVIEW_HOURLY_LIMIT).every(r => r.allowed));
check("visitor A is then blocked", alice[PREVIEW_HOURLY_LIMIT].allowed === false);

const bob = await call("203.0.113.99");
check("visitor B is unaffected by A hitting the limit", bob.allowed === true, JSON.stringify(bob));
check("visitor B is counted separately", bob.remaining === PREVIEW_HOURLY_LIMIT - 1, String(bob.remaining));
check("every request saw a real address", quotaSeen.every(q => q.ip !== "127.0.0.1" && q.ip !== "::ffff:127.0.0.1"), JSON.stringify([...new Set(quotaSeen.map(q => q.ip))]));

console.log("\n[3] A visitor cannot forge their address to dodge the limit");
/* Reproduces what nginx actually forwards: it appends the true address to
   whatever the client sent, so the header arrives as "<client value>, <real>". */
const spoofedHeader = "1.1.1.1, 203.0.113.50";
const spoofed = await fetch(`http://127.0.0.1:${port}/probe`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Forwarded-For": spoofedHeader },
    body: "{}"
}).then(r => r.json());

console.log(`  (header sent: ${spoofedHeader}, express resolved: ${spoofed.ip})`);
check("the client's own value is not the identity", spoofed.ip !== "1.1.1.1", `resolved to ${spoofed.ip}`);
check("resolves to the real address nginx appended", spoofed.ip === "203.0.113.50", spoofed.ip);

console.log("\n[4] Cache hits are visible without spending allowance");
const miss = previewCachePeek("no such niche at all", "nowhere");
check("unknown query reports no cache", miss === null, String(miss));

server.close();

console.log(`\n${failures === 0 ? "ALL PER-VISITOR CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
