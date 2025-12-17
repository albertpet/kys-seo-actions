import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";
import pLimit from "p-limit";
import { z } from "zod";

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

/**
 * Simple API-key auth for Actions calls
 * Header: X-API-KEY: <your key>
 */
function requireApiKey(req, res, next) {
  const required = process.env.ACTIONS_API_KEY;
  if (!required) return res.status(500).json({ error: "Server missing ACTIONS_API_KEY" });
  const got = req.header("X-API-KEY");
  if (!got || got !== required) return res.status(401).json({ error: "Unauthorized" });
  next();
}

app.get("/health", (req, res) => res.json({ ok: true }));

/**
 * POST /serp/google
 * body: { q, location?, hl?, gl?, num? }
 * Uses SerpApi (authorized provider).
 */
app.post("/serp/google", requireApiKey, async (req, res) => {
  const schema = z.object({
    q: z.string().min(1),
    location: z.string().optional(), // e.g. "United States"
    hl: z.string().optional(),       // e.g. "en"
    gl: z.string().optional(),       // e.g. "us"
    num: z.number().int().min(1).max(100).optional()
  });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const { q, location, hl, gl, num } = parsed.data;

  const serpKey = process.env.SERPAPI_KEY;
  if (!serpKey) return res.status(500).json({ error: "Server missing SERPAPI_KEY" });

  const params = new URLSearchParams({
    engine: "google",
    q,
    api_key: serpKey,
    ...(location ? { location } : {}),
    ...(hl ? { hl } : {}),
    ...(gl ? { gl } : {}),
    ...(num ? { num: String(num) } : {})
  });

  const url = `https://serpapi.com/search.json?${params.toString()}`;

  const r = await fetch(url, { method: "GET" });
  if (!r.ok) return res.status(502).json({ error: "SerpApi request failed", status: r.status });
  const data = await r.json();

  // Return a slimmed structure for GPT consumption
  const out = {
    query: data.search_parameters ?? {},
    search_metadata: data.search_metadata ?? {},
    knowledge_graph: data.knowledge_graph ?? null,
    related_questions: data.related_questions ?? [],
    related_searches: data.related_searches ?? [],
    organic_results: (data.organic_results ?? []).map((x) => ({
      position: x.position,
      title: x.title,
      link: x.link,
      displayed_link: x.displayed_link,
      snippet: x.snippet,
      rich_snippet: x.rich_snippet,
      sitelinks: x.sitelinks
    }))
  };

  res.json(out);
});

/**
 * Fetch HTML with safe defaults.
 */
async function fetchHtml(url) {
  const r = await fetch(url, {
    method: "GET",
    redirect: "follow",
    headers: {
      "User-Agent":
        "Mozilla/5.0 (compatible; KY-SEO-Actions/1.0; +https://example.com/privacy)"
    },
    // node-fetch doesn't support timeout option directly; do basic via AbortController
  });

  const ct = r.headers.get("content-type") || "";
  if (!r.ok) throw new Error(`Fetch failed: ${r.status}`);
  if (!ct.includes("text/html") && !ct.includes("application/xhtml+xml")) {
    throw new Error(`Unsupported content-type: ${ct}`);
  }
  const html = await r.text();
  return html;
}

function extractStructure(html, url) {
  const dom = new JSDOM(html, { url });
  const doc = dom.window.document;

  const title = doc.querySelector("title")?.textContent?.trim() || "";
  const metaDescription =
    doc.querySelector('meta[name="description"]')?.getAttribute("content")?.trim() || "";

  const canonical =
    doc.querySelector('link[rel="canonical"]')?.getAttribute("href")?.trim() || "";

  const headings = [];
  ["h1", "h2", "h3"].forEach((tag) => {
    doc.querySelectorAll(tag).forEach((el) => {
      const t = el.textContent?.trim();
      if (t) headings.push({ tag, text: t });
    });
  });

  const links = [];
  doc.querySelectorAll("a[href]").forEach((a) => {
    const href = a.getAttribute("href")?.trim();
    const text = a.textContent?.trim() || "";
    if (href && !href.startsWith("javascript:")) links.push({ href, text });
  });

  // Readability extraction
  const reader = new Readability(doc);
  const article = reader.parse();

  return {
    url,
    title,
    meta_description: metaDescription,
    canonical,
    headings,
    text_content: article?.textContent?.trim() || "",
    excerpt: (article?.textContent || "").trim().slice(0, 600),
    links: links.slice(0, 200)
  };
}

/**
 * POST /page/fetch
 * body: { url }
 * returns: { url, html }
 */
app.post("/page/fetch", requireApiKey, async (req, res) => {
  const schema = z.object({ url: z.string().url() });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  try {
    const html = await fetchHtml(parsed.data.url);
    res.json({ url: parsed.data.url, html });
  } catch (e) {
    res.status(502).json({ error: String(e.message || e) });
  }
});

/**
 * POST /page/extract
 * body: { url }
 * returns: structured extraction
 */
app.post("/page/extract", requireApiKey, async (req, res) => {
  const schema = z.object({ url: z.string().url() });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  try {
    const html = await fetchHtml(parsed.data.url);
    const out = extractStructure(html, parsed.data.url);
    res.json(out);
  } catch (e) {
    res.status(502).json({ error: String(e.message || e) });
  }
});

/**
 * POST /page/extract_batch
 * body: { urls: string[], concurrency?: number }
 */
app.post("/page/extract_batch", requireApiKey, async (req, res) => {
  const schema = z.object({
    urls: z.array(z.string().url()).min(1).max(10),
    concurrency: z.number().int().min(1).max(5).optional()
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const limit = pLimit(parsed.data.concurrency ?? 3);

  try {
    const results = await Promise.all(
      parsed.data.urls.map((u) =>
        limit(async () => {
          try {
            const html = await fetchHtml(u);
            return { ok: true, data: extractStructure(html, u) };
          } catch (e) {
            return { ok: false, error: String(e.message || e), url: u };
          }
        })
      )
    );
    res.json({ results });
  } catch (e) {
    res.status(502).json({ error: String(e.message || e) });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`API running on :${port}`));
