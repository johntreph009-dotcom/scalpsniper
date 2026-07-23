const CTX_TTL_MS = 45e3;
const SQUEEZE_THRESHOLD_PCT = 0.8;
const STABLE_TTL_MS = 6 * 60 * 60 * 1e3;
const OVERHEAD_SCALE = 110;
const STABLE_FALLBACK_USD = 279e9;
const g = globalThis;
function sma(a, n) {
  const s = a.slice(-n);
  return s.reduce((x, y) => x + y, 0) / (s.length || 1);
}
function rsi14(closes) {
  let up = 0, dn = 0;
  const s = closes.slice(-15);
  for (let i = 1; i < s.length; i++) {
    const d = s[i] - s[i - 1];
    if (d > 0) up += d;
    else dn -= d;
  }
  if (dn === 0) return 100;
  const rs = up / 14 / (dn / 14);
  return +(100 - 100 / (1 + rs)).toFixed(1);
}
async function getStablecoinFloat() {
  const now = Date.now();
  if (g._stable && now - g._stable.t < STABLE_TTL_MS) return { usd: g._stable.usd, real: true };
  try {
    const r = await fetch("https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=tether,usd-coin,dai,first-digital-usd,ethena-usde,usds,paypal-usd,true-usd&order=market_cap_desc&per_page=20&page=1", { headers: { "Accept": "application/json" } });
    if (!r.ok) throw new Error("coingecko " + r.status);
    const j = await r.json();
    const total = (Array.isArray(j) ? j : []).reduce((s, c) => s + (+(c.market_cap ?? 0) || 0), 0);
    if (total < 5e10) throw new Error("stable total too small");
    g._stable = { t: now, usd: total };
    return { usd: total, real: true };
  } catch {
    return { usd: g._stable?.usd ?? STABLE_FALLBACK_USD, real: !!g._stable };
  }
}
async function analyzeMarketContext(symbol) {
  const j = async (u) => {
    const r = await fetch(u);
    if (!r.ok) throw new Error("http " + r.status);
    return r.json();
  };
  const rb = await j(`https://api.bybit.com/v5/market/kline?category=spot&symbol=${symbol}&interval=15&limit=96`);
  const kl = (rb.result?.list ?? []).slice().reverse();
  if (kl.length < 40) throw new Error("no klines");
  const closes = kl.map((k) => +String(k[4]));
  const highs = kl.map((k) => +String(k[2]));
  const lows = kl.map((k) => +String(k[3]));
  const qVols = kl.map((k) => +String(k[6]));
  const last = closes[closes.length - 1];
  const fast = sma(closes, 10), slow = sma(closes, 30);
  const fastPrev = sma(closes.slice(0, -3), 10), slowPrev = sma(closes.slice(0, -3), 30);
  const cross = fastPrev <= slowPrev && fast > slow ? "golden" : fastPrev >= slowPrev && fast < slow ? "dead" : "none";
  const state = last > fast && fast > slow ? "bullish" : last < fast && fast < slow ? "bearish" : "ranging";
  const trend = { state, rsi: rsi14(closes), fast: +fast.toFixed(6), slow: +slow.toFixed(6), cross };
  const gapPct = +(Math.abs(fast - slow) / slow * 100).toFixed(3);
  const squeeze = { active: gapPct < SQUEEZE_THRESHOLD_PCT, gapPct, thresholdPct: SQUEEZE_THRESHOLD_PCT };
  const atrArr = [];
  for (let i = 1; i < kl.length; i++) {
    atrArr.push(Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1])));
  }
  const atrNow = sma(atrArr, 14), atrPrev = sma(atrArr.slice(0, -8), 14);
  const volNow = sma(qVols, 8), volPrev = sma(qVols.slice(0, -8), 8);
  const priceRising = last > closes[closes.length - 9];
  const atrTrend = atrNow > atrPrev * 1.05 ? "rising" : atrNow < atrPrev * 0.95 ? "falling" : "flat";
  const volTrend = volNow > volPrev * 1.05 ? "rising" : volNow < volPrev * 0.95 ? "falling" : "flat";
  const liquidity = {
    fadingRobots: priceRising && volTrend === "falling" && atrTrend !== "rising",
    atr: +atrNow.toFixed(6),
    atrTrend,
    volTrend,
    priceRising
  };
  let oiNotional = 0;
  try {
    const oi = await j(`https://api.bybit.com/v5/market/open-interest?category=linear&symbol=${symbol}&intervalTime=5min&limit=1`);
    oiNotional = +(oi.result?.list?.[0]?.openInterest ?? 0) * last;
  } catch {
  }
  const stab = await getStablecoinFloat();
  const overhead = {
    index: +(oiNotional / stab.usd * OVERHEAD_SCALE).toFixed(2),
    // реальный знаменатель (стейбл-флоат) × калибровочный SCALE
    oiNotionalUsd: Math.round(oiNotional),
    stablecoinBalanceUsd: Math.round(stab.usd),
    mock: !stab.real
  };
  let alarm_level = "NONE", scenario = "baseline_trend", directive = "";
  if (overhead.index > 4) {
    alarm_level = "CRITICAL";
    scenario = "liquidation_cascade";
    directive = "\u041A\u0440\u0438\u0442\u0438\u0447\u0435\u0441\u043A\u0438\u0439 \u043F\u0435\u0440\u0435\u0433\u0440\u0435\u0432 \u043A\u0440\u0435\u0434\u0438\u0442\u043D\u044B\u0445 \u043F\u043B\u0435\u0447\u0435\u0439. \u041A\u0430\u0441\u043A\u0430\u0434 \u043B\u0438\u043A\u0432\u0438\u0434\u0430\u0446\u0438\u0439 \u043D\u0435\u0438\u0437\u0431\u0435\u0436\u0435\u043D. \u0418\u0441\u043F\u043E\u043B\u044C\u0437\u043E\u0432\u0430\u0442\u044C \u0436\u0435\u0441\u0442\u043A\u0438\u0435 \u0441\u0442\u043E\u043F\u044B.";
  } else if (trend.state === "bearish" && squeeze.active && liquidity.fadingRobots) {
    alarm_level = "HIGH";
    scenario = "fake_breakout_up";
    directive = "\u041E\u0436\u0438\u0434\u0430\u0435\u0442\u0441\u044F \u0441\u043A\u0432\u0438\u0437 \u0448\u043E\u0440\u0442\u0438\u0441\u0442\u043E\u0432. \u041A\u043E\u043D\u0442\u0440\u0442\u0440\u0435\u043D\u0434\u043E\u0432\u044B\u0439 \u043B\u043E\u043D\u0433 \u0437\u0430\u043F\u0440\u0435\u0449\u0435\u043D. \u0416\u0434\u0430\u0442\u044C \u043F\u0440\u043E\u0431\u043E\u044F \u043A\u0440\u0430\u0441\u043D\u043E\u0439 \u0441\u043A\u043E\u043B\u044C\u0437\u044F\u0449\u0435\u0439 \u0432\u043D\u0438\u0437.";
  } else if (squeeze.active) {
    alarm_level = "INFO";
    scenario = "volatility_compression";
    directive = "\u0421\u0436\u0430\u0442\u0438\u0435 \u0432\u043E\u043B\u0430\u0442\u0438\u043B\u044C\u043D\u043E\u0441\u0442\u0438: \u043E\u0436\u0438\u0434\u0430\u0435\u0442\u0441\u044F \u0441\u0438\u043B\u044C\u043D\u044B\u0439 \u0438\u043C\u043F\u0443\u043B\u044C\u0441, \u0442\u043E\u0440\u0433\u043E\u0432\u043B\u044F \u0432\u043D\u0443\u0442\u0440\u0438 \u0434\u0438\u0430\u043F\u0430\u0437\u043E\u043D\u0430 \u0437\u0430\u043F\u0440\u0435\u0449\u0435\u043D\u0430.";
  } else {
    directive = trend.state === "bearish" ? "\u0422\u0440\u0435\u043D\u0434 \u043C\u0435\u0434\u0432\u0435\u0436\u0438\u0439: \u043A\u043E\u043D\u0442\u0440\u0442\u0440\u0435\u043D\u0434 \u0431\u0435\u0437 \u0441\u0442\u043E\u043F\u0430 \u2014 \u0443\u0431\u0438\u0439\u0441\u0442\u0432\u043E \u0434\u0435\u043F\u043E\u0437\u0438\u0442\u0430." : trend.state === "bullish" ? "\u0422\u0440\u0435\u043D\u0434 \u0431\u044B\u0447\u0438\u0439: \u043F\u0440\u0438\u043E\u0440\u0438\u0442\u0435\u0442 \u043B\u043E\u043D\u0433\u043E\u0432, \u0448\u043E\u0440\u0442 \u0442\u043E\u043B\u044C\u043A\u043E \u0441\u043E \u0441\u0442\u043E\u043F\u043E\u043C \u0437\u0430 \u0441\u0442\u0440\u0443\u043A\u0442\u0443\u0440\u043E\u0439." : "\u0420\u0435\u0439\u043D\u0434\u0436: \u0440\u0430\u0431\u043E\u0442\u0430\u0442\u044C \u043E\u0442 \u0433\u0440\u0430\u043D\u0438\u0446, \u0436\u0434\u0430\u0442\u044C \u0432\u044B\u0445\u043E\u0434\u0430.";
  }
  return { symbol, at: Date.now(), trend, squeeze, liquidity, overhead, alarm_level, scenario, directive };
}
const ALLOWED_ORIGINS = /* @__PURE__ */ new Set([
  "https://app.scalpsniper.com",
  "https://johntreph009-dotcom.github.io",
  "http://localhost:8788",
  "http://localhost:3000",
  "http://127.0.0.1:8788"
]);
const ALLOWED_MODELS = /* @__PURE__ */ new Set(["claude-haiku-4-5-20251001", "claude-sonnet-5"]);
const DEFAULT_MODEL = "claude-sonnet-5";
function corsHeaders(origin, wildcard = false) {
  const allowed = wildcard ? "*" : origin && ALLOWED_ORIGINS.has(origin) ? origin : "";
  return {
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin"
  };
}
function json(status, body, origin, wildcard = false) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...corsHeaders(origin, wildcard) } });
}
async function fetchRss(u, srcName) {
  const r = await fetch(u, { headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36", "Accept": "application/rss+xml, application/xml, text/xml, */*" } });
  if (!r.ok) throw new Error(srcName + " http " + r.status);
  const x = await r.text();
  const its = [...x.matchAll(/<item>[\s\S]*?<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>[\s\S]*?(?:<pubDate>([\s\S]*?)<\/pubDate>)?[\s\S]*?<\/item>/g)];
  const items = its.slice(0, 25).map((m) => ({ title: m[1].replace(/<[^>]+>/g, "").trim(), src: srcName, ts: m[2] ? Date.parse(m[2]) || Date.now() : Date.now() })).filter((i) => i.title);
  if (!items.length) throw new Error(srcName + " empty");
  return items;
}
var src_default = {
  async fetch(request, env, ctx) {
    const origin = request.headers.get("Origin");
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(origin, url.pathname === "/api/context") });
    if (url.pathname !== "/api/context" && origin && !ALLOWED_ORIGINS.has(origin)) return json(403, { error: "origin_not_allowed" }, null);
    if (url.pathname === "/api/context" && request.method === "GET") {
      const symbol = (url.searchParams.get("symbol") || "BTCUSDT").toUpperCase().replace(/[^A-Z0-9]/g, "");
      g._ctxCache = g._ctxCache || {};
      const c = g._ctxCache[symbol];
      if (c && Date.now() - c.t < CTX_TTL_MS) return json(200, c.d, origin, true);
      try {
        const d = await analyzeMarketContext(symbol);
        g._ctxCache[symbol] = { t: Date.now(), d };
        return json(200, d, origin, true);
      } catch (err) {
        return json(502, { error: "context_unavailable", detail: err instanceof Error ? err.message : "unknown" }, origin, true);
      }
    }
    if (url.pathname === "/api/news" && request.method === "GET") {
      if (g._newsCache && Date.now() - g._newsCache.t < 3e5) return json(200, g._newsCache.d, origin);
      let items = [];
      const dbg = [];
      for (const [u, name] of [
        ["https://forklog.com/feed", "ForkLog"],
        // русскоязычные приоритетно
        ["https://ru.cointelegraph.com/rss", "CoinTelegraph RU"],
        ["https://bits.media/rss/", "Bits.media"],
        ["https://cointelegraph.com/rss", "CoinTelegraph"]
        // англ. фолбэк
      ]) {
        try {
          items = await fetchRss(u, name);
          dbg.push(name + ":ok");
          break;
        } catch (e) {
          dbg.push(String(e instanceof Error ? e.message : e).slice(0, 40));
        }
      }
      if (!items.length) {
        try {
          const r = await fetch("https://min-api.cryptocompare.com/data/v2/news/?lang=EN");
          if (r.ok) {
            const d = await r.json();
            items = (d.Data || []).slice(0, 25).map((n) => ({ title: n.title || "", src: n.source_info?.name || "CryptoCompare", ts: (n.published_on || 0) * 1e3 }));
            dbg.push("CC:" + items.length);
          } else dbg.push("CC http " + r.status);
        } catch (e) {
          dbg.push("CC " + String(e instanceof Error ? e.message : e).slice(0, 30));
        }
      }
      const payload = { items, at: Date.now(), dbg };
      if (items.length) g._newsCache = { t: Date.now(), d: payload };
      return json(200, payload, origin);
    }
    if (url.pathname !== "/api/analyze" || request.method !== "POST") return json(404, { error: "not_found" }, origin);
    const auth = request.headers.get("Authorization") ?? "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
    if (token.length < 16) return json(401, { error: "unauthorized" }, origin);
    const userId = token;
    let user;
    try {
      user = await env.DB.prepare("SELECT id, pro_status, ai_credits FROM users WHERE id = ?1").bind(userId).first();
    } catch (err) {
      console.error("D1 select failed:", err instanceof Error ? err.message : "unknown");
      return json(500, { error: "db_unavailable" }, origin);
    }
    if (!user || user.ai_credits <= 0) return json(402, { error: "payment_required", credits: user?.ai_credits ?? 0 }, origin);
    let body;
    try {
      body = await request.json();
    } catch {
      return json(400, { error: "bad_request" }, origin);
    }
    if (!Array.isArray(body.messages) || body.messages.length === 0) return json(400, { error: "bad_request", detail: "messages[] required" }, origin);
    const model = body.model && ALLOWED_MODELS.has(body.model) ? body.model : DEFAULT_MODEL;
    let upstream;
    try {
      upstream = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "Content-Type": "application/json" },
        body: JSON.stringify({ model, max_tokens: Math.min(body.max_tokens ?? 1500, 4e3), ...body.system ? { system: body.system } : {}, messages: body.messages })
      });
    } catch (err) {
      console.error("Anthropic fetch failed:", err instanceof Error ? err.message : "unknown");
      return json(502, { error: "upstream_unavailable" }, origin);
    }
    if (upstream.ok) {
      ctx.waitUntil(env.DB.prepare("UPDATE users SET ai_credits = ai_credits - 1 WHERE id = ?1 AND ai_credits > 0").bind(userId).run().catch((err) => console.error("debit failed:", err instanceof Error ? err.message : "unknown")));
    }
    return new Response(upstream.body, { status: upstream.status, headers: { "Content-Type": upstream.headers.get("Content-Type") ?? "application/json", ...corsHeaders(origin) } });
  }
};
export {
  src_default as default
};
