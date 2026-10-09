# Stock Catalyst AI

An evidence-first AI-assisted research workbench for medium-risk US stock swing research. It gathers available market data, computes technical indicators locally, builds a structured research report, and saves it for review.

**Research only.** A person makes every final decision. The application never places trades and has no brokerage or trading API integration. It does not use Bitget data APIs, MCP, or Agent Hub. Live data availability depends on the configured providers. Demonstration data is synthetic and is labelled throughout the application.

## Run the offline demo

Requirements: Node.js 22.18+ and Corepack.

```powershell
corepack.cmd pnpm install
Copy-Item .env.example .env.local
```

In `.env.local`, set `DEMO_MODE=true` and `DATABASE_AUTO_MIGRATE=true` (the latter is the default). Start the application:

```powershell
corepack.cmd pnpm dev
```

Open <http://localhost:3000>, use the preselected `NVDA` symbol, choose a risk level and horizon, enter a research question, and select **Generate research report**. The deterministic offline market data and report template are prominently labelled as synthetic demonstration content. Review the report, tick the human-decision acknowledgement, and save the acknowledgement. Open **Reports** to revisit the saved report or download Markdown/JSON exports.

To seed one reproducible example report directly into the local history before opening the UI, run `corepack.cmd pnpm db:seed` after copying the environment file. This command forces demo mode for that process and writes no external requests.

No API keys are needed for this demo. A missing AI key never produces a fabricated AI response: outside demo mode, the report request returns an explicit unavailable error while market data and local indicators continue to work.

## Optional live providers

Copy `.env.example` to `.env.local`, then add only the keys for services you have configured. Qwen is required for live AI-generated reports. Finnhub, Alpha Vantage, and Twelve Data are optional market providers. Stooq is keyless and enabled by default. Keep `.env.local` private; credentials are read on the server only and are not returned by the settings page.

## Verification

```powershell
corepack.cmd pnpm run typecheck
corepack.cmd pnpm test
corepack.cmd pnpm run lint
corepack.cmd pnpm run build
```

## Environment variables

`.env.example` contains placeholders and documented defaults. Important variables:

| Variable | Purpose |
| --- | --- |
| `DEMO_MODE` | Force deterministic synthetic market data and the labelled offline report template. |
| `DATABASE_PATH` | Local SQLite report database path. |
| `DATABASE_AUTO_MIGRATE` | Create/update the local report table automatically. |
| `QWEN_API_KEY` | Server-only credential for live Qwen report generation. |
| `QWEN_BASE_URL`, `QWEN_MODEL` | Qwen-compatible endpoint and model. |
| `FINNHUB_API_KEY`, `ALPHAVANTAGE_API_KEY`, `TWELVEDATA_API_KEY` | Optional market-data provider credentials. |
| `MARKET_DATA_PROVIDER` | Provider preference order, or `demo`. |

Other timeout, cache, upload, request-size, and rate-limit settings are documented inline in `.env.example` and parsed in `src/lib/config/env.ts`.

See [docs/PLAN.md](docs/PLAN.md) for the original architecture and product guardrails. The current implementation checklist is in [PLAN.md](PLAN.md).
