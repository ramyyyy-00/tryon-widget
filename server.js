// Minimal backend for the try-on widget.
// Job: keep the permanent Decart API key on the server, hand out short-lived
// client tokens to the browser, and count sessions per brand (so you can bill them).
import "dotenv/config";
import express from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDecartClient } from "@decartai/sdk";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;

if (!process.env.DECART_API_KEY) {
  console.warn("WARNING: DECART_API_KEY is not set. /api/tokens will fail until you add it to .env");
}

const brands = JSON.parse(fs.readFileSync(path.join(__dirname, "brands.json"), "utf8"));
const allOrigins = new Set(Object.values(brands).flatMap((b) => b.origins));

// ---- tiny usage counter (a JSON file). Replace with a database when you have real clients.
const USAGE_FILE = path.join(__dirname, "usage.json");
function readUsage() {
  try {
    return JSON.parse(fs.readFileSync(USAGE_FILE, "utf8"));
  } catch {
    return {};
  }
}
function countSession(brandId) {
  const month = new Date().toISOString().slice(0, 7); // e.g. 2026-11
  const usage = readUsage();
  usage[brandId] = usage[brandId] || {};
  usage[brandId][month] = (usage[brandId][month] || 0) + 1;
  fs.writeFileSync(USAGE_FILE, JSON.stringify(usage, null, 2));
  return usage[brandId][month];
}
function sessionsThisMonth(brandId) {
  const month = new Date().toISOString().slice(0, 7);
  return readUsage()[brandId]?.[month] || 0;
}

const app = express();
app.use(express.json());

// Only the brands' own websites may call the API from a browser.
app.use(
  cors({
    origin(origin, cb) {
      if (!origin || allOrigins.has(origin)) return cb(null, true);
      return cb(new Error("Origin not allowed"));
    },
  })
);

// Per-IP rate limit so nobody can burn your credit.
const limiter = rateLimit({ windowMs: 10 * 60 * 1000, limit: 10, standardHeaders: true, legacyHeaders: false });

app.post("/api/tokens", limiter, async (req, res) => {
  try {
    const brandId = req.body?.brandId || "demo";
    const brand = brands[brandId];
    if (!brand) return res.status(400).json({ error: "Unknown brand" });

    const origin = req.get("origin");
    if (origin && !brand.origins.includes(origin)) {
      return res.status(403).json({ error: "This website is not allowed for this brand" });
    }
    if (sessionsThisMonth(brandId) >= brand.monthlySessionLimit) {
      return res.status(429).json({ error: "Monthly try-on limit reached" });
    }

    const client = createDecartClient({ apiKey: process.env.DECART_API_KEY });
    const token = await client.tokens.create();
    const used = countSession(brandId);
    console.log(`[session] brand=${brandId} count_this_month=${used}`);
    res.json(token);
  } catch (err) {
    console.error("token error:", err?.message || err);
    res.status(500).json({ error: "Could not start a try-on session" });
  }
});

app.get("/health", (_req, res) => res.json({ ok: true }));

// Static files: the widget script and the demo page.
app.use("/widget", express.static(path.join(__dirname, "public")));
app.use("/demo", express.static(path.join(__dirname, "demo")));

app.listen(PORT, () => {
  console.log(`Try-on server running on http://localhost:${PORT}`);
  console.log(`Demo page: http://localhost:${PORT}/demo/`);
});
