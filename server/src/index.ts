/**
 * ScalpSniper Worker: AI-прокси + новостной агрегатор + CF Context Engine.
 *
 * Эндпоинты:
 *   POST /api/analyze            — прокси в Anthropic (Bearer → D1-кредиты → списание)
 *   GET  /api/news               — агрегатор новостей (CryptoPanic RSS → CoinTelegraph → CoinDesk → CryptoCompare), кэш 5 мин
 *   GET  /api/context?symbol=X   — CF Context Engine: синхронный мэтчинг индикаторов CryptoFamily, кэш 45с, CORS *
 *
 * Секреты: ANTHROPIC_API_KEY, JWT_SECRET — только `wrangler secret put`.
 */

export interface Env {
  DB: D1Database;
  ANTHROPIC_API_KEY: string;
  JWT_SECRET: string;
}

/* ══════════════════════ CF CONTEXT ENGINE — типы ══════════════════════ */

export type TrendState = 'bullish' | 'bearish' | 'ranging';
export type AlarmLevel = 'NONE' | 'INFO' | 'HIGH' | 'CRITICAL';

/** Вектор Тренда: Trend Alma MA / CF Trend RSI */
export interface TrendVector {
  state: TrendState;      // bearish = ниже скользящих / dead cross · bullish = golden cross
  rsi: number;            // CF Trend RSI (14)
  fast: number;           // быстрая MA (ALMA-приближение)
  slow: number;           // медленная MA
  cross: 'golden' | 'dead' | 'none';
}

/** Вектор Сжатия: CKS Squeeze — «узкое горлышко» между MA */
export interface SqueezeVector {
  active: boolean;        // true → волатильность сжата, торговля внутри диапазона запрещена
  gapPct: number;         // |fast−slow|/slow, %
  thresholdPct: number;   // порог срабатывания
}

/** Вектор Ликвидности: VIX ATR + затухание роботов */
export interface LiquidityVector {
  fadingRobots: boolean;  // цена растёт, объёмы/ATR падают → ММ «высушил» рынок
  atr: number;
  atrTrend: 'rising' | 'falling' | 'flat';
  volTrend: 'rising' | 'falling' | 'flat';
  priceRising: boolean;
}

/** Вектор Кредитного Перегрева: Market Overhead Index = OI / Stablecoin Balance */
export interface OverheadVector {
  index: number;          // ~1.5 безопасно · >4 критический перегрев (OI/стейбл-флоат × SCALE)
  oiNotionalUsd: number;
  stablecoinBalanceUsd: number; // реальный глобальный стейбл-флоат (CoinGecko, кэш 6ч), см. getStablecoinFloat()
  mock: boolean;          // true только если CoinGecko недоступен и кэша ещё нет (фолбэк)
}

export interface MarketContext {
  symbol: string;
  at: number;
  trend: TrendVector;
  squeeze: SqueezeVector;
  liquidity: LiquidityVector;
  overhead: OverheadVector;
  alarm_level: AlarmLevel;
  scenario: string;
  directive: string;      // текст-наблюдение для трейдера (НЕ приказ на исполнение)
}

/* ══════════════════════ CF CONTEXT ENGINE — расчёт ══════════════════════ */

const CTX_TTL_MS = 45_000;                      // обновление раз в 45с — не считаем на каждый реквест
const SQUEEZE_THRESHOLD_PCT = 0.8;              // спека даёт «< 5%», но на 15m-крипте 5% ловит всё подряд;
                                                // 0.8% — рабочее «узкое горлышко», вынесено в константу
const STABLE_TTL_MS = 6 * 60 * 60 * 1000;       // стейбл-саплай меняется медленно — кэш 6ч
const OVERHEAD_SCALE = 110;                     // index = OI(Bybit) / глобальный стейбл-флоат × SCALE.
                                                // Калибровка июль-2026: BTC ≈1.4 (норма ~1.5), >4 ⇒ OI ~×3 от текущего = реальный экстрим.
                                                // Что «живое»: знаменатель тянется из CoinGecko, реагирует на реальное расширение/сжатие стейблов.
const STABLE_FALLBACK_USD = 279_000_000_000;    // фолбэк, если CoinGecko недоступен и кэша ещё нет
type CtxCache = Record<string, { t: number; d: MarketContext }>;
const g = globalThis as unknown as { _ctxCache?: CtxCache; _newsCache?: { t: number; d: unknown }; _stable?: { t: number; usd: number } };

function sma(a: number[], n: number): number {
  const s = a.slice(-n);
  return s.reduce((x, y) => x + y, 0) / (s.length || 1);
}

function rsi14(closes: number[]): number {
  let up = 0, dn = 0;
  const s = closes.slice(-15);
  for (let i = 1; i < s.length; i++) {
    const d = s[i]! - s[i - 1]!;
    if (d > 0) up += d; else dn -= d;
  }
  if (dn === 0) return 100;
  const rs = (up / 14) / (dn / 14);
  return +(100 - 100 / (1 + rs)).toFixed(1);
}

/** ⚠️ НЕ РАБОТАЕТ ИЗ CF WORKERS: CoinGecko блокирует egress-IP Cloudflare (как Binance) → эта функция
 *  всегда падает в фолбэк (mock:true). Overhead оживлён НА ФРОНТЕ (scalpsniper.html: _cgStableFloat +
 *  _binOiFetch, агрегат OI Bybit+Binance / стейбл-флоат CoinGecko, SCALE 38). Здесь оставлено как есть;
 *  при wrangler-деплое overhead будет мок — фронт его перекрывает. Не полагаться на серверный overhead.
 *  Реальный глобальный стейбл-флоат = «сухой порох» рынка (топ-стейблы, CoinGecko), кэш 6ч.
 *  Публичного API стейбл-балансов ПО КОНКРЕТНОЙ бирже нет — используем глобальную капитализацию
 *  как макро-знаменатель: расширение/сжатие стейблов реально двигает overhead. real=false → фолбэк/старый кэш. */
async function getStablecoinFloat(): Promise<{ usd: number; real: boolean }> {
  const now = Date.now();
  if (g._stable && now - g._stable.t < STABLE_TTL_MS) return { usd: g._stable.usd, real: true };
  try {
    const r = await fetch('https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=tether,usd-coin,dai,first-digital-usd,ethena-usde,usds,paypal-usd,true-usd&order=market_cap_desc&per_page=20&page=1', { headers: { 'Accept': 'application/json' } });
    if (!r.ok) throw new Error('coingecko ' + r.status);
    const j = await r.json() as Array<{ market_cap?: number }>;
    const total = (Array.isArray(j) ? j : []).reduce((s, c) => s + (+(c.market_cap ?? 0) || 0), 0);
    if (total < 5e10) throw new Error('stable total too small');
    g._stable = { t: now, usd: total };
    return { usd: total, real: true };
  } catch {
    return { usd: g._stable?.usd ?? STABLE_FALLBACK_USD, real: !!g._stable };
  }
}

async function analyzeMarketContext(symbol: string): Promise<MarketContext> {
  const j = async (u: string) => { const r = await fetch(u); if (!r.ok) throw new Error('http ' + r.status); return r.json() as Promise<unknown>; };

  // Данные: 15m klines (96 = сутки), open interest
  // Bybit v5 — Binance (и его зеркало) отдают 403 с IP Cloudflare Workers; Bybit открыт
  const rb = await j(`https://api.bybit.com/v5/market/kline?category=spot&symbol=${symbol}&interval=15&limit=96`) as { result?: { list?: string[][] } };
  const kl = (rb.result?.list ?? []).slice().reverse(); // Bybit отдаёт новые первыми → разворачиваем
  if (kl.length < 40) throw new Error('no klines');
  const closes = kl.map(k => +String(k[4]));
  const highs = kl.map(k => +String(k[2]));
  const lows = kl.map(k => +String(k[3]));
  const qVols = kl.map(k => +String(k[6])); // turnover (quote volume)
  const last = closes[closes.length - 1]!;

  // 1) Вектор Тренда (ALMA-приближение: SMA10/SMA30 — веса ALMA не критичны для вектора)
  const fast = sma(closes, 10), slow = sma(closes, 30);
  const fastPrev = sma(closes.slice(0, -3), 10), slowPrev = sma(closes.slice(0, -3), 30);
  const cross: TrendVector['cross'] = fastPrev <= slowPrev && fast > slow ? 'golden' : fastPrev >= slowPrev && fast < slow ? 'dead' : 'none';
  const state: TrendState = last > fast && fast > slow ? 'bullish' : last < fast && fast < slow ? 'bearish' : 'ranging';
  const trend: TrendVector = { state, rsi: rsi14(closes), fast: +fast.toFixed(6), slow: +slow.toFixed(6), cross };

  // 2) Вектор Сжатия
  const gapPct = +(Math.abs(fast - slow) / slow * 100).toFixed(3);
  const squeeze: SqueezeVector = { active: gapPct < SQUEEZE_THRESHOLD_PCT, gapPct, thresholdPct: SQUEEZE_THRESHOLD_PCT };

  // 3) Вектор Ликвидности: ATR14 + тренды объёма/ATR при росте цены
  const atrArr: number[] = [];
  for (let i = 1; i < kl.length; i++) {
    atrArr.push(Math.max(highs[i]! - lows[i]!, Math.abs(highs[i]! - closes[i - 1]!), Math.abs(lows[i]! - closes[i - 1]!)));
  }
  const atrNow = sma(atrArr, 14), atrPrev = sma(atrArr.slice(0, -8), 14);
  const volNow = sma(qVols, 8), volPrev = sma(qVols.slice(0, -8), 8);
  const priceRising = last > closes[closes.length - 9]!;
  const atrTrend = atrNow > atrPrev * 1.05 ? 'rising' : atrNow < atrPrev * 0.95 ? 'falling' : 'flat';
  const volTrend = volNow > volPrev * 1.05 ? 'rising' : volNow < volPrev * 0.95 ? 'falling' : 'flat';
  const liquidity: LiquidityVector = {
    fadingRobots: priceRising && volTrend === 'falling' && atrTrend !== 'rising',
    atr: +atrNow.toFixed(6), atrTrend, volTrend, priceRising,
  };

  // 4) Вектор Кредитного Перегрева
  let oiNotional = 0;
  try {
    const oi = await j(`https://api.bybit.com/v5/market/open-interest?category=linear&symbol=${symbol}&intervalTime=5min&limit=1`) as { result?: { list?: Array<{ openInterest: string }> } };
    oiNotional = +(oi.result?.list?.[0]?.openInterest ?? 0) * last;
  } catch { /* spot-only символы без OI */ }
  const stab = await getStablecoinFloat();
  const overhead: OverheadVector = {
    index: +(oiNotional / stab.usd * OVERHEAD_SCALE).toFixed(2), // реальный знаменатель (стейбл-флоат) × калибровочный SCALE
    oiNotionalUsd: Math.round(oiNotional), stablecoinBalanceUsd: Math.round(stab.usd), mock: !stab.real,
  };

  // ── Синхронный мэтчинг (правила спеки, по приоритету) ──
  let alarm_level: AlarmLevel = 'NONE', scenario = 'baseline_trend', directive = '';
  if (overhead.index > 4) {
    alarm_level = 'CRITICAL'; scenario = 'liquidation_cascade';
    directive = 'Критический перегрев кредитных плечей. Каскад ликвидаций неизбежен. Использовать жесткие стопы.';
  } else if (trend.state === 'bearish' && squeeze.active && liquidity.fadingRobots) {
    alarm_level = 'HIGH'; scenario = 'fake_breakout_up';
    directive = 'Ожидается сквиз шортистов. Контртрендовый лонг запрещен. Ждать пробоя красной скользящей вниз.';
  } else if (squeeze.active) {
    alarm_level = 'INFO'; scenario = 'volatility_compression';
    directive = 'Сжатие волатильности: ожидается сильный импульс, торговля внутри диапазона запрещена.';
  } else {
    directive = trend.state === 'bearish'
      ? 'Тренд медвежий: контртренд без стопа — убийство депозита.'
      : trend.state === 'bullish'
        ? 'Тренд бычий: приоритет лонгов, шорт только со стопом за структурой.'
        : 'Рейндж: работать от границ, ждать выхода.';
  }
  return { symbol, at: Date.now(), trend, squeeze, liquidity, overhead, alarm_level, scenario, directive };
}

/* ══════════════════════ HTTP-слой ══════════════════════ */

const ALLOWED_ORIGINS = new Set<string>([
  'https://app.scalpsniper.com',
  'https://johntreph009-dotcom.github.io',
  'http://localhost:8788', 'http://localhost:3000', 'http://127.0.0.1:8788',
]);
const ALLOWED_MODELS = new Set(['claude-haiku-4-5-20251001', 'claude-sonnet-5']);
const DEFAULT_MODEL = 'claude-sonnet-5';

function corsHeaders(origin: string | null, wildcard = false): HeadersInit {
  const allowed = wildcard ? '*' : (origin && ALLOWED_ORIGINS.has(origin) ? origin : '');
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Max-Age': '86400', 'Vary': 'Origin',
  };
}
function json(status: number, body: unknown, origin: string | null, wildcard = false): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...corsHeaders(origin, wildcard) } });
}

async function fetchRss(u: string, srcName: string): Promise<Array<{ title: string; src: string; ts: number }>> {
  const r = await fetch(u, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', 'Accept': 'application/rss+xml, application/xml, text/xml, */*' } });
  if (!r.ok) throw new Error(srcName + ' http ' + r.status);
  const x = await r.text();
  const its = [...x.matchAll(/<item>[\s\S]*?<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>[\s\S]*?(?:<pubDate>([\s\S]*?)<\/pubDate>)?[\s\S]*?<\/item>/g)];
  const items = its.slice(0, 25).map(m => ({ title: m[1]!.replace(/<[^>]+>/g, '').trim(), src: srcName, ts: m[2] ? (Date.parse(m[2]) || Date.now()) : Date.now() })).filter(i => i.title);
  if (!items.length) throw new Error(srcName + ' empty');
  return items;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const origin = request.headers.get('Origin');
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(origin, url.pathname === '/api/context') });
    if (url.pathname !== '/api/context' && origin && !ALLOWED_ORIGINS.has(origin)) return json(403, { error: 'origin_not_allowed' }, null);

    // ── GET /api/context — CF Context Engine (CORS *, кэш 45с) ──
    if (url.pathname === '/api/context' && request.method === 'GET') {
      const symbol = (url.searchParams.get('symbol') || 'BTCUSDT').toUpperCase().replace(/[^A-Z0-9]/g, '');
      g._ctxCache = g._ctxCache || {};
      const c = g._ctxCache[symbol];
      if (c && Date.now() - c.t < CTX_TTL_MS) return json(200, c.d, origin, true);
      try {
        const d = await analyzeMarketContext(symbol);
        g._ctxCache[symbol] = { t: Date.now(), d };
        return json(200, d, origin, true);
      } catch (err) {
        return json(502, { error: 'context_unavailable', detail: err instanceof Error ? err.message : 'unknown' }, origin, true);
      }
    }

    // ── GET /api/news ──
    if (url.pathname === '/api/news' && request.method === 'GET') {
      if (g._newsCache && Date.now() - g._newsCache.t < 300_000) return json(200, g._newsCache.d, origin);
      let items: Array<{ title: string; src: string; ts: number }> = []; const dbg: string[] = [];
      for (const [u, name] of [
        ['https://forklog.com/feed', 'ForkLog'],                       // русскоязычные приоритетно
        ['https://ru.cointelegraph.com/rss', 'CoinTelegraph RU'],
        ['https://bits.media/rss/', 'Bits.media'],
        ['https://cointelegraph.com/rss', 'CoinTelegraph'],            // англ. фолбэк
      ] as const) {
        try { items = await fetchRss(u, name); dbg.push(name + ':ok'); break; }
        catch (e) { dbg.push(String(e instanceof Error ? e.message : e).slice(0, 40)); }
      }
      if (!items.length) {
        try {
          const r = await fetch('https://min-api.cryptocompare.com/data/v2/news/?lang=EN');
          if (r.ok) { const d = await r.json() as { Data?: Array<{ title?: string; source_info?: { name?: string }; published_on?: number }> };
            items = (d.Data || []).slice(0, 25).map(n => ({ title: n.title || '', src: n.source_info?.name || 'CryptoCompare', ts: (n.published_on || 0) * 1000 })); dbg.push('CC:' + items.length); }
          else dbg.push('CC http ' + r.status);
        } catch (e) { dbg.push('CC ' + String(e instanceof Error ? e.message : e).slice(0, 30)); }
      }
      const payload = { items, at: Date.now(), dbg };
      if (items.length) g._newsCache = { t: Date.now(), d: payload };
      return json(200, payload, origin);
    }

    if (url.pathname !== '/api/analyze' || request.method !== 'POST') return json(404, { error: 'not_found' }, origin);

    // ── POST /api/analyze: Bearer → D1-кредиты → Anthropic → фоновое списание ──
    const auth = request.headers.get('Authorization') ?? '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
    if (token.length < 16) return json(401, { error: 'unauthorized' }, origin);
    const userId = token; // мок до JWT

    let user: { id: string; pro_status: number; ai_credits: number } | null;
    try {
      user = await env.DB.prepare('SELECT id, pro_status, ai_credits FROM users WHERE id = ?1').bind(userId).first();
    } catch (err) {
      console.error('D1 select failed:', err instanceof Error ? err.message : 'unknown');
      return json(500, { error: 'db_unavailable' }, origin);
    }
    if (!user || user.ai_credits <= 0) return json(402, { error: 'payment_required', credits: user?.ai_credits ?? 0 }, origin);

    let body: { messages: unknown[]; model?: string; max_tokens?: number; system?: string };
    try { body = await request.json(); } catch { return json(400, { error: 'bad_request' }, origin); }
    if (!Array.isArray(body.messages) || body.messages.length === 0) return json(400, { error: 'bad_request', detail: 'messages[] required' }, origin);
    const model = body.model && ALLOWED_MODELS.has(body.model) ? body.model : DEFAULT_MODEL;

    let upstream: Response;
    try {
      upstream = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, max_tokens: Math.min(body.max_tokens ?? 1500, 4000), ...(body.system ? { system: body.system } : {}), messages: body.messages }),
      });
    } catch (err) {
      console.error('Anthropic fetch failed:', err instanceof Error ? err.message : 'unknown');
      return json(502, { error: 'upstream_unavailable' }, origin);
    }
    if (upstream.ok) {
      ctx.waitUntil(env.DB.prepare('UPDATE users SET ai_credits = ai_credits - 1 WHERE id = ?1 AND ai_credits > 0').bind(userId).run()
        .catch((err: unknown) => console.error('debit failed:', err instanceof Error ? err.message : 'unknown')));
    }
    return new Response(upstream.body, { status: upstream.status, headers: { 'Content-Type': upstream.headers.get('Content-Type') ?? 'application/json', ...corsHeaders(origin) } });
  },
} satisfies ExportedHandler<Env>;
