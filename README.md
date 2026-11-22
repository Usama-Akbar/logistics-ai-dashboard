# Logistics Analytics — AI-assisted dashboard

A web app for exploring one logistics dataset (400 orders, 2025) in three ways:

| Level | Where | What |
|---|---|---|
| Descriptive | **Dashboard** tab | 5 KPIs and 4 charts, filterable by period, carrier and region |
| Diagnostic | **Ask the data** tab | Natural-language questions → validated query plan → computed answer + chart + explanation |
| Predictive / prescriptive | **Forecast** tab, or ask e.g. "How much inventory should I plan?" | Monthly demand forecast, backtested method selection, safety-stock inventory recommendation |

**Live app:** https://logistics-ai-dashboard-five.vercel.app — no login required.

**Core rule:** the AI model only *interprets* questions. It picks a tool and fills a strict schema; the app validates that plan, computes the result in TypeScript, and writes the answer itself. The model never sees the data rows, never writes SQL, and its free text is never shown as an answer.

---

## Setup

Requirements: Node 20+.

```bash
npm install
cp .env.example .env.local     # add GROQ_API_KEY (free at console.groq.com/keys)
npm run dev                     # http://localhost:3000
npm test                        # 38 unit tests (engine, time logic, forecasting, orchestration)
```

Docker:

```bash
docker build -t logistics-analytics .
docker run -p 3000:3000 -e GROQ_API_KEY=gsk_... logistics-analytics
```

### Environment variables

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `GROQ_API_KEY` | For the Ask tab | — | Groq API key (the free tier is enough for review traffic). Without it the Ask tab says so; the Dashboard and Forecast tabs still work. |
| `GROQ_MODEL` | No | `openai/gpt-oss-120b` | Groq model that interprets questions. Must support tool calling. |
| `GROQ_FALLBACK_MODELS` | No | `openai/gpt-oss-20b,qwen/qwen3.8-27b` | Comma-separated models tried, in order, when the primary model is rate-limited or unavailable |
| `AI_EFFORT` | No | `low` | Reasoning effort for gpt-oss models (`low` ≈ 1 s per question; `medium` is slower with no accuracy gain in testing) |
| `ASK_RATE_LIMIT` | No | `20` | Questions per IP per minute, per server instance |

Keys live in env vars only (`.env*` is git-ignored).

### Deploying (Vercel)

1. Import the repo into Vercel (it detects Next.js; no build settings needed).
2. Add `GROQ_API_KEY` under Project → Settings → Environment Variables.
3. Deploy. The CSV ships with the server functions through `outputFileTracingIncludes` in `next.config.ts`.

---

## Architecture

```
Browser (React, Recharts)
  │  Dashboard ── POST /api/query  (QuerySpec[]) ──┐
  │  Forecast  ── POST /api/forecast (ForecastSpec)┤
  │  Ask       ── POST /api/ask (question) ─┐      │
  ▼                                         ▼      │
                         AI orchestrator (src/lib/ai)
                         LLM (Groq) + 3 strict tools ──► zod validation ──► data-aware checks
                                                         │ rejected → errors go back to the model (max 3 tries)
                                                         ▼ accepted
                         Analytics engine (src/lib/analytics) ◄──────────┘
                         Forecasting      (src/lib/forecast)
                                   │
                         Semantic layer: metric + dimension definitions
                                   │
                         Data layer: CSV → validated, frozen Order[] (read-only)
```

| Layer | Files | Job |
|---|---|---|
| Data | `src/lib/data/orders.ts` | Parse the CSV once, validate every row with zod, derive `delivery_days`, freeze the rows, and produce a data-quality report (rejected rows, missing dates by status, duplicates, value mismatches). |
| Semantic layer | `src/lib/analytics/semantic.ts` | The only place metrics are defined. Dashboard, AI tool and tests all use it, so "on-time rate" can't mean two different things. |
| Query contract | `src/lib/analytics/querySpec.ts` | Zod schemas for `QuerySpec`, `ForecastSpec`, `Clarify`. They're turned into the strict tool JSON schemas, so validation and the model's contract come from one source. |
| Engine | `engine.ts`, `time.ts` | Validate filter values against real data (case-insensitive; "Leeds" → "Leeds, UK"), resolve time presets, filter, group (time buckets are zero-filled), compute, sort, limit, warn. |
| Presentation | `present.ts` | Picks the chart type with fixed rules and writes the answer text from the result. |
| Forecasting | `src/lib/forecast/` | Three methods, rolling-origin backtest, automatic selection, safety stock. |
| AI orchestration | `src/lib/ai/` | System prompt with a data catalog, tool definitions, the validate → retry → execute loop, plan cache. |
| API | `src/app/api/*` | Thin route handlers. `/api/ask` adds input limits, per-IP rate limiting and typed provider-error handling. |

### Key design decisions

- **In-memory data, no database.** 400 rows parse in a few milliseconds. Postgres would add infrastructure, a migration and a connection pool and buy nothing at this size. Since all queries go through `QuerySpec`, the engine could later be swapped for a SQL builder behind the same contract.
- **Structured queries, not text-to-SQL.** The model can only pick from enums (metrics, dimensions, time presets) and give filter values, and those values are checked against the data. That makes injection or "creative" queries impossible and makes every result reproducible from its plan.
- **The model never writes answers.** Answers are built from computed values (`composeAnswer`, `composeForecastAnswer`). A second LLM call to "phrase" results would read more smoothly but would bring back the chance of misquoted numbers. Correctness comes first here.
- **Relative dates use the data's as-of date.** The data ends 2025-12-30 and real "today" is much later, so "last month" against the real calendar would always be empty. Presets resolve against the latest order date, and every answer says so.
- **Explicit metric definitions** (shown in the UI on hover and in every explanation):
  - *Delivered* = status `delivered` (on time). *Delayed* = status `delayed` (delivered late).
  - *Completed shipments* = delivered + delayed + exception, i.e. orders with a known outcome. In-transit (27) and canceled (3) orders have no delivery date and are left out of rate denominators.
  - *On-time rate* = delivered ÷ completed = 304 / 370 = **82.2%**. *Delay rate* = delayed ÷ completed. On-time + delay + exception rates sum to 100%.
  - *Avg delivery time* = mean(delivery_date − order_date) over orders that have a delivery date = **3.83 days**.
- **Rates come with their sample size.** Every rate shows "x of n". Groups under 15 shipments get a warning. Example: GLS has the highest delay rate (25%), but that's 2 of 8 shipments.

### Data flow (one question)

`"How many orders were delivered late last month?"`

1. **Interpretation.** The model gets the question, a system prompt with the catalog (metric definitions, every real carrier/region/warehouse/category/city value, date coverage, as-of date) and three tools. It returns `query_analytics({metrics:["delayed_count"], group_by:"none", date_field:"delivery_date", time_range:{preset:"previous_month"}, …})`.
2. **Validation.** Zod checks the schema. The engine then checks filter values against the data and checks date ranges for sanity. If anything fails, the errors go back to the model as `tool_result` errors and it gets up to 3 tries in total.
3. **Computation.** `previous_month` resolves to 2025-11-01 → 2025-11-30 on `delivery_date`. The engine filters status = delayed and counts **3**.
4. **Presentation.** The chart rule picks a stat tile (single value), and the answer text is built from the result.
5. **Explanation.** The UI shows the interpretation, the resolved range, the filters, metric definitions, why that chart was chosen, the JSON plan, the data table with CSV export, and an orchestration trace (model, tool calls, rejected attempts, latency, cache hits).

---

## AI approach

### How questions are interpreted

- One chat-completions call to Groq (default model `openai/gpt-oss-120b`, `temperature: 0`, `reasoning_effort: low`) through the official `groq-sdk`. Tool schemas are generated from the zod schemas with `strict: true`, and every argument is validated again with zod on our side, so a malformed or invalid call is rejected and sent back to the model rather than executed.
- **Why Groq:** it has a free tier and very low latency, and interpretation is a small task (short question → small JSON plan), so a large paid model isn't needed. The provider sits behind one file (`src/lib/ai/orchestrator.ts`); the engine, semantic layer and UI don't depend on it.
- The system prompt is built from the dataset, so the same data always gives the same prompt. It holds the vocabulary mapping ("late" → `delayed_count`, "transit time" → `avg_delivery_days`, "last quarter" → `previous_quarter`, …) plus every valid filter value. That way the model can map words like "UK deliveries" or "Leeds" to the right fields.
- **Follow-ups.** The previous question and its plan are sent along as context, so "now by month" or "what about UPS?" become complete standalone plans.

### How tools are selected

| Tool | Chosen when | Computation |
|---|---|---|
| `query_analytics` | Counts, rates, averages, trends, rankings, breakdowns | Analytics engine |
| `forecast_demand` | Predict, forecast, "how much stock/inventory" | Forecasting module |
| `ask_clarification` | Ambiguity that would materially change the answer ("Which carrier is best?") | None. The UI shows 2–4 clickable, complete questions |
| *(no tool)* | Question not answerable from this data (costs, satisfaction, …) | The app shows a fixed "not in this dataset" message and never the model's text |

`query_analytics` takes a list of 1–3 queries, so a compound question ("on-time rate for FedEx and average delivery time by region") is answered in one call, and each query becomes its own answer card. An earlier version relied on parallel tool calls, but the model rarely made them, so the second half of compound questions was dropped.

**Rate limits and fallback.** Groq's free tier limits tokens per minute per model, counts `max_tokens` against that limit, and one question uses about 2,500 input tokens. So:
- `max_tokens` is kept small (1,024; 600 for Qwen), since a tool call needs only a few hundred.
- When a model returns 429, a 5xx, a network error, or Groq's own `tool_use_failed` (the model produced malformed tool-call JSON), the same request goes straight to the next model: `gpt-oss-120b` → `gpt-oss-20b` → `qwen3.8-27b`. Each has its own quota.
- If all three are rate-limited and Groq's `retry-after` is 20 s or less, the server waits once and retries instead of failing.
- The trace shows which model answered.

In testing, a burst of 8 questions in about 15 s was answered without errors.

### Forecasting

- **Series:** units ordered per calendar month (sum of `quantity` by `order_date`), canceled orders excluded, empty months counted as 0. History: Jan–Dec 2025 (12 points).
- **Methods:** 3-month moving average, least-squares linear trend, and simple exponential smoothing (α picked from a grid by in-sample SSE).
- **Selection:** a rolling-origin backtest over the last 4 months (fit on earlier months, predict one month ahead). The method with the lowest MAE wins. All three are shown with MAE, RMSE and parameters.
- **Inventory recommendation:** forecast demand over the horizon + safety stock, where safety stock = z(service level) × backtest RMSE × √horizon. Default service level is 95%, z = 1.645. The forecast chart shows a band of ±z × RMSE × √(months ahead).
- **Sparse SKUs:** 355 SKUs across 400 orders means most SKUs have 1–3 orders, which you can't model honestly. When a SKU has fewer than 6 active months, the app forecasts its **category** instead and sizes the SKU by its historical share of category units. It says this explicitly rather than fitting a model to one data point.
- **Outliers** (e.g. January's 233 units against a ~109 mean) are flagged because they drag trend methods.

---

## Assumptions

- The CSV is the complete, authoritative dataset and is read-only. The app never writes to it.
- `status` is the source of truth for delivery outcome. There's no promised-date column, so "late" means status `delayed`, not something computed from dates.
- Time filters use `order_date` unless the question is about deliveries ("delivered late last month" → `delivery_date`). The plan always shows which one was used.
- "Last N months" = N full calendar months ending with the as-of month. "Last month" = the full calendar month before it. Weeks run Monday–Sunday.
- The latest month (Dec 2025, data through the 30th) is treated as complete for forecasting.
- "Demand" = units ordered, so canceled orders are excluded from forecasts.
- `region` is treated as the destination region.

## Limitations / unsupported

- One grouping dimension per query (no "by carrier *and* month" pivot). Up to 3 metrics can share it, and compound questions can use multiple calls.
- No user-requested chart types ("as a pie"). Chart choice follows fixed rules.
- No period-over-period comparison in one plan (e.g. "Nov vs Oct change"). The model would need two calls.
- Forecasts are univariate. They ignore promotions, seasonality (one year of data can't estimate it) and lead times, and the safety-stock formula assumes roughly normal, independent errors.
- The plan cache and rate limiter are in memory and per serverless instance (fine for a demo, not shared across instances).
- On Groq's free tier, sustained heavy use (roughly more than 8 new questions a minute across all users) can exhaust all three models' quotas; the Ask tab then shows a "rate-limited, try again shortly" message. Repeated questions are served from the plan cache and use no quota. A paid Groq tier removes this.
- The fallback models are smaller and occasionally answer only one part of a compound question; the primary model handles these reliably.
- No authentication. The public endpoint is protected by input limits and per-IP rate limiting only.

## Future improvements

- Postgres plus a typed SQL builder behind the same `QuerySpec` contract, for larger datasets.
- Two-dimension pivots and period-over-period comparisons as first-class query features.
- Seasonal models (Holt-Winters) once more than 2 years of history exist; forecasts by warehouse or region; lead-time-aware reorder points.
- An evaluation set of ~50 question → expected-plan pairs, run in CI, to catch interpretation regressions when prompts or models change.
- Shared cache and rate limit (Redis), plus auth if it's opened beyond reviewers.
- Saved queries and pinning answers to the dashboard.

---

## AI usage disclosure

- **In the product:** an LLM served by Groq (`openai/gpt-oss-120b` by default) interprets natural-language questions into structured tool calls, as described above. It doesn't compute or write answers.
- **In development:** this project was built with an AI coding assistant (Claude Code, by Anthropic), which helped with scaffolding, implementation, tests and this README. Design decisions, metric definitions and expected test values were checked against the raw CSV with an independent script. The unit tests in `tests/` pin the key numbers (400 orders, 304 delivered, 55 delayed, 82.2% on time, 3.83 days average, GLS 2/8 delay rate, 3 late deliveries in Nov 2025).
