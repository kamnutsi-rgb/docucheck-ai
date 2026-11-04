const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const MAX_WORDS_PER_REQUEST = 40;
const MIN_REQUEST_GAP_MS = 300;
const cache = new Map();

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function jsonResponse(statusCode, payload) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff"
    },
    body: JSON.stringify(payload)
  };
}

function decodeEntities(value) {
  return value
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

function textOnly(html) {
  return decodeEntities(String(html).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ")).trim();
}

function parseLookupResponse(html) {
  if (typeof html !== "string" || !html.trim()) throw new Error("Empty dictionary response");
  if (html.includes("ไม่พบคำศัพท์ที่ต้องการค้นหา")) return "not_found";
  if (/class=["']panel-heading["']/i.test(html) && /class=["']panel-body["']/i.test(html)) return "found";
  throw new Error("Unrecognized dictionary response");
}

export const handler = async (event) => {
  if (event.httpMethod !== "POST") return jsonResponse(405, { error: "Method not allowed" });

  let body;
  try { body = JSON.parse(event.body || "{}"); }
  catch { return jsonResponse(400, { error: "Invalid JSON body" }); }

  if (!Array.isArray(body.words) || body.words.length > MAX_WORDS_PER_REQUEST) {
    return jsonResponse(400, { error: `Send between 1 and ${MAX_WORDS_PER_REQUEST} words per request` });
  }

  const words = [...new Set(body.words.map((value) => String(value || "").normalize("NFC").trim()))];
  if (!words.length || words.some((word) => !word || [...word].length > 80 || !/\p{Script=Thai}/u.test(word))) {
    return jsonResponse(400, { error: "Only non-empty Thai words up to 80 characters are accepted" });
  }

  let nextStartAt = Date.now();
  const takeRequestSlot = async () => {
    const startAt = Math.max(Date.now(), nextStartAt);
    nextStartAt = startAt + MIN_REQUEST_GAP_MS;
    await delay(Math.max(0, startAt - Date.now()));
  };

  const results = new Array(words.length);
  let cursor = 0;
  const worker = async () => {
    while (true) {
      const index = cursor++;
      if (index >= words.length) return;
      const word = words[index];
      const cached = cache.get(word);
      if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
        results[index] = { word, status: cached.status };
        continue;
      }
      try {
        await takeRequestSlot();
        const form = new URLSearchParams({ word, funcName: "lookupWord", status: "lookup" });
        const response = await fetch("https://dictionary.orst.go.th/func_lookup.php", {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
            "Accept": "text/html"
          },
          body: form,
          signal: AbortSignal.timeout(12000)
        });
        if (!response.ok) throw new Error(`Dictionary returned HTTP ${response.status}`);
        const status = parseLookupResponse(await response.text());
        cache.set(word, { status, at: Date.now() });
        results[index] = { word, status };
      } catch {
        results[index] = { word, status: "error" };
      }
    }
  };

  await Promise.all([worker(), worker()]);
  return jsonResponse(200, {
    source: "https://dictionary.orst.go.th/",
    checkedAt: new Date().toISOString(),
    results
  });
};

export const _test = { parseLookupResponse, textOnly };

