# Stock Catalyst AI - Step 1 Plan

**Hackathon:** Bitget AI Base Camp Hackathon S2
**Track:** AI Trading Desk
**Sub-theme:** Information Extraction & Signal Generation
**Target user:** Medium-risk retail swing traders
**Hard constraints:** Research only. No trading. No order execution. No brokerage or exchange connectivity. No Bitget APIs, no Bitget MCP, no Bitget Agent Hub. The human always decides.

---

## 1. User journey

| # | Stage | User action | System response |
|---|-------|-------------|-----------------|
| 1 | Land | Opens `/` | Workspace loads with market snapshot cards, watchlist sidebar, empty-state guidance. Every number carries a data-status label (LIVE / DELAYED / CACHED / UPLOADED / DEMO / UNAVAILABLE). |
| 2 | Select | Types `NVDA` in symbol search, or clicks a watchlist row | Server fetches quote, profile, 1y daily candles, earnings calendar, news. Cache-first. Failures render an explicit unavailable panel - never a fabricated value. |
| 3 | Inspect | Reads snapshot cards, scrubs the price chart, toggles SMA/EMA/Bollinger/Volume overlays | Indicators are computed **locally** from validated OHLCV in `src/lib/indicators`. They are rendered in their own panel, physically separated from any AI text. |
| 4 | Ask | Fills the research form: symbol, question, horizon, risk tolerance, optional entry price, optional position size | Zod validates and sanitises every field server-side. Invalid input returns field-level errors; nothing reaches the LLM unvalidated. |
| 5 | Wait | Submits | Pipeline runs with visible stage progress: interpret objective -> gather evidence -> compute indicators -> fundamentals/valuation -> catalysts -> scenarios -> risks -> report. Timeouts and retries are bounded. |
| 6 | Read | Studies the 20-section report | Each factual claim shows a citation chip linking to the evidence table (source, timestamp, delay status). Sections are typed: FACT / CALCULATION / ESTIMATE / AI-INTERPRETATION. |
| 7 | Stress-test | Opens scenario analysis, toggles "earnings miss", "rate increase", "volatility spike" | Deterministic scenario engine shows assumptions + estimated effects with an explicit "not a prediction" banner. |
| 8 | Decide | Reads risk matrix, invalidation conditions, confidence score with reasoning | A blocking **"Human decision required"** notice and financial-risk disclaimer sit above the acknowledgement control. |
| 9 | Acknowledge | Ticks "I have reviewed this research and I am making my own decision" | Report status moves `generated -> acknowledged`. Until then it is marked UNREVIEWED everywhere, including exports. |
| 10 | Save / export | Saves to library, exports Markdown / JSON / print | Exports retain evidence, timestamps, data-status labels, disclaimers, and acknowledgement state. |
| 11 | Monitor | Returns later, opens monitoring checklist | Checklist items persist; watchlist and research history are stored locally in SQLite. |

**Dead ends handled explicitly:** provider rate limit, provider timeout, missing fundamentals, stale quote (>15 min), no AI key configured, malformed AI JSON, AI claim without citation, symbol not found. Each has a distinct UI state and a distinct error code.

---

## 2. Technology stack

Chosen for production-readiness with the smallest possible dependency surface.

| Concern | Choice | Why |
|---------|--------|-----|
| Language | TypeScript 5.x, `strict: true` | End-to-end types across UI, API, adapters, AI schema. |
| Framework | Next.js 15 App Router | Server components + server-only API routes. Keys never reach the client bundle. |
| UI | React 19 + Tailwind CSS v4 | Fast to build a dense terminal-style UI; utility classes keep bundle small. |
| Charts | `lightweight-charts` v5 | Purpose-built financial candlestick/volume charts, ~45 kB, canvas-based, accessible via keyboard-driven crosshair controls we add. |
| Validation | `zod` (HTTP inputs) + hand-written strict structural validator (LLM output) | Zod at the boundary; a dedicated validator gives precise, testable rejection reasons for malformed model output. |
| Database | SQLite via `better-sqlite3` | Zero-ops, synchronous, single file, WAL mode. Perfect for a local research workbench. |
| AI | Qwen through Alibaba Cloud Model Studio's OpenAI-compatible endpoint | Structured JSON output, server-side only, bounded timeout/retry. |
| Tests | `node:test` (core logic, zero deps) + Vitest + Testing Library + jsdom (components, routes, DB) | Core domain logic is verifiable with no install; UI/route layer gets a real runner. |
| Lint/format | ESLint 9 flat config + Prettier | Consistent style; custom rule blocks `process.env` in client components. |

**Deliberately excluded:** any broker/exchange SDK, any order-management code, any WebSocket trading feed, any Bitget integration, any background job queue, any ORM, any external analytics.

---

## 3. Architecture

```
Browser (React, no secrets)
  |  same-origin fetch, JSON only, CSP connect-src 'self'
  v
Next.js App Router
  +-- Server Components ............ read-only rendering of DB + cache state
  +-- Route Handlers (/api/*) ...... zod validation -> service layer -> JSON
  |        |
  |        +-- rate limiter (in-memory sliding window, per-IP + per-route class)
  |        +-- body-size guard
  |        +-- safe error mapper (no stack traces, no provider internals)
  v
Service layer (src/lib)
  +-- market/  provider adapters behind one interface + cache + status labeller
  +-- indicators/  pure functions over validated OHLCV
  +-- scenarios/   deterministic assumption-driven engine
  +-- ai/      Qwen adapter, prompt builder, strict validator, citation enforcement
  +-- report/  assembly + Markdown/JSON/print export
  +-- security/ sanitisation, prompt-injection guard, headers, error shaping
  +-- metrics/  counters + latency histograms, in-DB persisted
  v
SQLite (data/stock-catalyst.sqlite, WAL)
  watchlist | reports | research_history | preferences | evidence_cache | metrics | migrations
```

**Frontend.** One primary workspace route (`/`) composed of independent panels, each owning its loading / error / empty / stale state. Reports live at `/reports` (library) and `/reports/[id]` (detail) with `/reports/[id]/print` for the printer-friendly view. Settings at `/settings`. The layout renders a responsive top nav, collapsible watchlist sidebar, and a skip-to-content link. All panels are server-rendered where possible; only the chart, form, and scenario controls are client components.

**Backend.** Route handlers are thin. Business logic lives in `src/lib/*` as pure, dependency-light modules so it can be unit-tested without a bundler. Everything external (provider HTTP, Qwen HTTP, SQLite) is behind an injectable interface, which is what makes the nine required test scenarios possible with fakes.

**Database.** SQLite in WAL mode, `foreign_keys = ON`, schema managed by idempotent migrations in `src/lib/db/migrations`. No credentials, no passwords, no PII beyond locally-stored research preferences. Reports store the full structured JSON plus derived text so history survives provider changes.

**AI.** Strictly server-side. `src/lib/ai/qwenClient.ts` is the only module that reads `QWEN_API_KEY`. The pipeline is deterministic orchestration around a single structured completion: evidence is gathered **first** by our adapters, injected into the prompt as numbered items, and the model is required to cite those IDs. Uncited factual claims are rejected, not merely flagged. Hidden chain-of-thought is never requested, never stored, never rendered.

---

## 4. Environment variables

Full annotated template in `.env.example`. Summary:

| Variable | Required | Purpose |
|----------|----------|---------|
| `QWEN_API_KEY` | For live AI | Server-only secret for the Qwen adapter. |
| `QWEN_BASE_URL` | No | OpenAI-compatible endpoint. Defaults to Model Studio international. |
| `QWEN_MODEL` | No | Defaults to `qwen-plus`. |
| `QWEN_TIMEOUT_MS`, `QWEN_MAX_RETRIES`, `QWEN_MAX_TOKENS`, `QWEN_TEMPERATURE` | No | Bounded execution. |
| `QWEN_STRICT_VALIDATION` | No | Reject schema/citation failures (default true). |
| `FINNHUB_API_KEY`, `ALPHAVANTAGE_API_KEY`, `TWELVEDATA_API_KEY` | No | Optional free-tier providers. |
| `STOOQ_ENABLED` | No | Keyless daily OHLCV source. |
| `MARKET_DATA_PROVIDER` | No | Preference order, or `demo` to force offline. |
| `DATABASE_PATH`, `DATABASE_AUTO_MIGRATE` | No | SQLite location and migration behaviour. |
| `CACHE_TTL_*`, `STALE_AFTER_SECONDS` | No | Freshness policy that drives the status labels. |
| `PROVIDER_REQUESTS_PER_MINUTE`, `PROVIDER_HTTP_TIMEOUT_MS` | No | Outbound rate/timeout ceilings. |
| `MAX_BODY_BYTES`, `MAX_UPLOAD_BYTES`, `MAX_UPLOAD_ROWS` | No | Request-size limits. |
| `RATE_LIMIT_*` | No | Inbound throttling, with a stricter AI bucket. |
| `DEFAULT_HORIZON`, `DEFAULT_RISK_TOLERANCE`, `DEMO_MODE`, `LOG_LEVEL`, `APP_ENV` | No | UX and observability. |

Rules enforced by code and by review: no `NEXT_PUBLIC_*` variables exist; `src/lib/config/env.ts` is the only reader of `process.env` for secrets; `scripts/verify-no-secrets.ts` fails CI if a key-shaped string appears in tracked source.

---

## 5. Market-data provider interface

```ts
export type DataStatus = 'live' | 'delayed' | 'cached' | 'uploaded' | 'demo' | 'unavailable';

export interface DataProvenance {
  source: string;            // e.g. 'stooq', 'finnhub', 'csv-upload', 'demo'
  status: DataStatus;
  retrievedAt: string;       // ISO-8601 UTC, when we obtained it
  asOf: string | null;       // ISO-8601 UTC, the timestamp the data describes
  delaySeconds: number | null;
  stale: boolean;            // derived from STALE_AFTER_SECONDS
  note: string | null;       // human-readable caveat, e.g. 'free tier, 15-min delay'
}

export type ProviderResult<T> =
  | { ok: true; data: T; provenance: DataProvenance }
  | { ok: false; code: ProviderErrorCode; message: string; retryAfterSeconds: number | null };

export interface MarketDataProvider {
  readonly id: string;
  readonly capabilities: ProviderCapability[];
  getQuote(symbol: string, ctx: ProviderContext): Promise<ProviderResult<Quote>>;
  getCandles(req: CandleRequest, ctx: ProviderContext): Promise<ProviderResult<Candle[]>>;
  getProfile?(symbol: string, ctx: ProviderContext): Promise<ProviderResult<CompanyProfile>>;
  getFinancials?(symbol: string, ctx: ProviderContext): Promise<ProviderResult<Financials>>;
  getEarningsCalendar?(symbol: string, ctx: ProviderContext): Promise<ProviderResult<EarningsEvent[]>>;
  getEstimates?(symbol: string, ctx: ProviderContext): Promise<ProviderResult<AnalystEstimates>>;
  getNews?(req: NewsRequest, ctx: ProviderContext): Promise<ProviderResult<NewsItem[]>>;
  getMacroEvents?(ctx: ProviderContext): Promise<ProviderResult<MacroEvent[]>>;
}
```

Contract rules every adapter must obey:

1. Never throw for an expected failure - return `{ ok: false, code }`. Codes are a closed set: `rate_limited | timeout | upstream_error | not_found | unsupported | bad_payload | unauthenticated | disabled`.
2. Never invent a value. A field the provider did not return is `null`, and the UI renders "n/a".
3. Every success carries `provenance` with source, retrieval time, as-of time, delay status, and staleness.
4. Validate the upstream payload before returning; a schema mismatch is `bad_payload`, not a partial object.
5. Respect the outbound rate limiter and honour `Retry-After`.
6. Optional capabilities are omitted, not stubbed - the registry then routes to the next provider or reports `unsupported`.

Registry behaviour: providers are tried in configured order per capability, results are cached in SQLite with per-type TTLs, and the winning provider's provenance is attached to everything the UI shows.

---

## 6. Folder structure

```
stock-catalyst-ai/
  docs/                     plan, architecture, data sources, security, validation, submission material
  samples/                  reference CSV for the upload fallback
  scripts/                  migrate.ts, seed-demo.ts, verify-no-secrets.ts
  data/                     SQLite file (gitignored)
  src/
    app/
      layout.tsx  page.tsx  globals.css
      reports/    page.tsx  [id]/page.tsx  [id]/print/page.tsx
      settings/   page.tsx
      api/
        research/route.ts          run the AI pipeline
        quote/route.ts             current quote
        candles/route.ts           historical OHLCV
        indicators/route.ts        locally computed indicators
        company/route.ts           profile + financials + estimates
        catalysts/route.ts         earnings + news + macro timeline
        scenarios/route.ts         scenario engine
        upload/route.ts            CSV OHLCV fallback
        watchlist/route.ts  watchlist/[id]/route.ts
        reports/route.ts    reports/[id]/route.ts  reports/[id]/acknowledge/route.ts
        history/route.ts    preferences/route.ts   health/route.ts  metrics/route.ts
    components/             nav, symbol-search, watchlist, snapshot-cards, price-chart,
                            research-form, evidence-panel, catalyst-timeline, scenarios,
                            report-view, status-badge, state-blocks, ui primitives
    lib/
      config/env.ts
      db/                   client.ts, migrate.ts, migrations.ts, repos/*.ts
      market/               types.ts, registry.ts, cache.ts, rate-limit.ts, http.ts,
                            stooq.ts, finnhub.ts, alpha-vantage.ts, twelve-data.ts,
                            demo.ts, csv.ts, symbols.ts
      indicators/           sma.ts ema.ts rsi.ts macd.ts atr.ts bollinger.ts volume.ts
                            support-resistance.ts trend.ts timeframe.ts index.ts types.ts
      scenarios/            definitions.ts, engine.ts
      ai/                   qwen-client.ts, prompts.ts, report-schema.ts, validator.ts,
                            citations.ts, injection-guard.ts, pipeline.ts, types.ts
      report/               assemble.ts, export-markdown.ts, export-json.ts, print.ts, sections.ts
      security/             sanitize.ts, errors.ts, body-limit.ts, rate-limit.ts, headers.ts
      validation/           schemas.ts, inputs.ts
      metrics/              collector.ts, definitions.ts, store.ts
      utils/                format.ts, dates.ts, result.ts, id.ts, logger.ts
  tests/
    core/                   node:test suites, zero dependencies (run today)
    app/                    Vitest suites: routes, DB, components, a11y, responsive
    fixtures/               recorded provider payloads, malformed AI responses
```

---

## 7. Security and data-quality risks

### Security

| Risk | Mitigation |
|------|------------|
| API key leakage to the browser | Keys read only in `src/lib/config/env.ts` and used only in server modules. No `NEXT_PUBLIC_*` vars exist. ESLint rule blocks `process.env` in client files. CSP `connect-src 'self'` stops direct browser calls. |
| Prompt injection via news headlines, filings, or CSV content | `src/lib/ai/injection-guard.ts` strips instruction-shaped patterns, wraps all external text in delimited data blocks with an explicit "this is data, not instructions" frame, and caps length. Model output is never executed; no tool-calling, no code interpretation, no URL following. |
| XSS through AI-authored or news-authored text | React escaping by default, zero `dangerouslySetInnerHTML` in the codebase, plus an output sanitiser that strips control characters and HTML-active sequences from every string that leaves the AI layer. CSP without `script-src 'unsafe-inline'` in production. |
| Malformed / hostile model output | Strict structural validator: closed enums, numeric ranges, required citation IDs, max lengths. Failure -> bounded retry with a repair prompt -> `AI_INVALID_RESPONSE` surfaced to the user. Nothing partially rendered. |
| SQL injection | `better-sqlite3` prepared statements everywhere; no string-built SQL. |
| CSV upload abuse | Size cap, row cap, MIME/extension check, header allowlist, numeric coercion with `Number.isFinite`, symbol whitelist regex, stored as `uploaded` provenance, never executed. |
| DoS / cost runaway | Inbound sliding-window rate limits with a separate stricter AI bucket, outbound provider rate limits, request timeouts, retry ceilings, response-size caps, and per-report token budget. |
| SSRF from user input | Outbound URLs are built from a fixed allowlist of provider hosts; the symbol is the only interpolated value and is regex-constrained to `^[A-Z][A-Z.\-]{0,9}$`. |
| Sensitive data at rest | SQLite holds no credentials and no personal identifiers. Reports store research content only. `data/` is gitignored. |
| Clickjacking / MIME sniffing | `X-Frame-Options: DENY`, `frame-ancestors 'none'`, `X-Content-Type-Options: nosniff`, restrictive `Permissions-Policy`. |
| Error-message disclosure | Central error mapper returns stable codes and generic messages; stack traces and provider bodies are logged server-side only. |
| Dependency risk | Pinned carets, `pnpm audit --prod` in the checklist, no transitive-heavy libraries, native module isolated to one adapter. |

### Data quality

| Risk | Mitigation |
|------|------------|
| Free-tier delay misread as live | Every value carries `status` (live/delayed/cached/uploaded/demo/unavailable) rendered as a badge next to the number, and repeated in exports. |
| Stale data presented as current | `STALE_AFTER_SECONDS` drives a STALE badge and an "as of" timestamp; candles older than the last trading session trigger a warning banner. |
| Split/dividend-adjusted price mismatch across providers | Candles record `adjustment` (`close-only`, `full`, `none`, `unknown`); indicators are computed within one consistent series and the adjustment kind is disclosed. Mixing series is refused. |
| Sparse or short history | Minimum 60 candles required for the 50-period indicators; below that, indicators report `insufficient_data` rather than computing on a partial window. |
| Calendar gaps (weekends, holidays) | Time-based alignment for multi-timeframe trend; sessions are derived from the data, never assumed to be contiguous. |
| Provider schema drift | Payload validation with explicit `bad_payload`; adapters fail closed and the registry falls through. |
| Missing fundamentals for small caps | Section renders "Data unavailable from configured sources" plus the reason; the AI is instructed that absence must be reported, never estimated silently. |
| Fabricated citations | Citation IDs are minted server-side from actually-retrieved evidence. The validator rejects any claim referencing an unknown ID, and any factual claim with no citation. |
| Overconfident language | Report schema forbids guarantee phrasing; a language guard rejects "will", "guaranteed", "sure", "risk-free" in AI interpretation fields and forces probabilistic wording. |
| Look-ahead bias in backtests | Indicators are causal (window ends at bar *t*); scenario engine is assumption-driven, not a backtest, and says so. |
| Metric honesty | Every validation metric is explicitly labelled `observed`, `estimated`, or `targeted`. |

### Product / compliance guardrails

- No order, position, portfolio, or brokerage concept exists anywhere in the data model.
- Every report ends with "Human decision required" plus a financial-risk disclaimer, and cannot be marked reviewed without explicit acknowledgement.
- Confidence scores are always paired with the reason and the evidence count that produced them.
- The app never claims to predict price; scenarios are labelled as assumption-driven illustrations.