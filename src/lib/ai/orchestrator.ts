import Groq from "groq-sdk";
import type { ChatCompletionMessageParam, ChatCompletionTool } from "groq-sdk/resources/chat/completions";
import { z } from "zod";
import { getDataset, type Dataset } from "@/lib/data/orders";
import { executeQuery, QueryValidationError, type QueryResult } from "@/lib/analytics/engine";
import { ClarifySchema, ForecastSpecSchema, QueryBatchSchema } from "@/lib/analytics/querySpec";
import { chooseChart, composeAnswer, type ChartChoice } from "@/lib/analytics/present";
import { composeForecastAnswer, runForecast, type ForecastResult } from "@/lib/forecast/forecast";
import { buildSystemPrompt } from "./prompt";

/**
 * Orchestration: question -> model picks a tool + structured input ->
 * validate (zod + data-aware checks) -> deterministic computation -> answer.
 * Validation failures are sent back to the model as tool errors so it can
 * self-correct (bounded retries). The model never sees or writes the answer.
 */

export const MODEL = process.env.GROQ_MODEL ?? "openai/gpt-oss-120b";
/**
 * Groq's free tier limits tokens per minute per model. When the primary model is rate-limited we
 * move to the next model (each has its own quota) instead of making the user wait for the window to reset.
 */
const FALLBACK_MODELS = (process.env.GROQ_FALLBACK_MODELS ?? "openai/gpt-oss-20b")
  .split(",")
  .map((m) => m.trim())
  .filter(Boolean);
export const MODELS = [MODEL, ...FALLBACK_MODELS.filter((m) => m !== MODEL)];
const EFFORT = (process.env.AI_EFFORT ?? "low") as "low" | "medium" | "high";
const MAX_ATTEMPTS = 3;
const MAX_TOOL_CALLS = 3;

export type Card =
  | { type: "query"; answer: string; chart: ChartChoice; result: QueryResult }
  | { type: "forecast"; answer: string; result: ForecastResult }
  | { type: "clarify"; question: string; options: string[] }
  | { type: "unsupported"; message: string };

export interface ToolCallTrace {
  tool: string;
  input: unknown;
  status: "executed" | "rejected";
  error?: string;
}

export interface AskResponse {
  question: string;
  cards: Card[];
  trace: { model: string; attempts: number; calls: ToolCallTrace[]; cached: boolean; latencyMs: number };
}

export interface PriorTurn {
  question: string;
  plan: unknown;
}

/** Strip JSON-schema keywords that strict tool schemas don't accept; zod still enforces them on our side. */
function toToolSchema(schema: z.ZodType): Record<string, unknown> {
  const unsupported = new Set(["$schema", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "minLength", "maxLength", "pattern", "minItems", "maxItems", "format"]);
  const clean = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(clean);
    if (node && typeof node === "object")
      return Object.fromEntries(Object.entries(node).filter(([k]) => !unsupported.has(k)).map(([k, v]) => [k, clean(v)]));
    return node;
  };
  return clean(z.toJSONSchema(schema)) as Record<string, unknown>;
}

const tool = (name: string, description: string, schema: z.ZodType): ChatCompletionTool => ({
  type: "function",
  function: { name, description, parameters: toToolSchema(schema), strict: true },
});

export const TOOLS: ChatCompletionTool[] = [
  tool(
    "query_analytics",
    "Compute KPIs, aggregations, trends, rankings and breakdowns over the orders dataset. Use for any descriptive or diagnostic question (counts, rates, averages, by time or by dimension). Pass one query per part of the question.",
    QueryBatchSchema,
  ),
  tool(
    "forecast_demand",
    "Forecast future monthly demand (units) for the whole business, a product category or a SKU, and recommend an inventory level with safety stock. Use for prediction, planning and 'how much stock' questions.",
    ForecastSpecSchema,
  ),
  tool("ask_clarification", "Ask the user to pick between concrete interpretations when the question is materially ambiguous.", ClarifySchema),
];

// Interpretation cache: same question (+ context) -> same validated plan. Results are recomputed (cheap, deterministic).
const planCache = new Map<string, { name: string; input: unknown }[]>();
const CACHE_LIMIT = 200;
const cacheKey = (q: string, prior?: PriorTurn | null) =>
  JSON.stringify([q.trim().toLowerCase().replace(/\s+/g, " "), prior ? prior.question.trim().toLowerCase() : null]);

/** Validate + execute one tool call. Throws a readable error message string on failure. */
export function executeToolCall(name: string, input: unknown, ds: Dataset): Card[] {
  const fmtZod = (e: z.ZodError) => e.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ");
  if (name === "query_analytics") {
    const parsed = QueryBatchSchema.safeParse(input);
    if (!parsed.success) throw new Error(`Invalid query spec — ${fmtZod(parsed.error)}`);
    const multi = parsed.data.queries.length > 1;
    return parsed.data.queries.map((spec, i) => {
      try {
        const result = executeQuery(spec, ds);
        return { type: "query", answer: composeAnswer(result), chart: chooseChart(result), result };
      } catch (e) {
        throw new Error(multi ? `queries[${i}]: ${errorText(e)}` : errorText(e));
      }
    });
  }
  if (name === "forecast_demand") {
    const parsed = ForecastSpecSchema.safeParse(input);
    if (!parsed.success) throw new Error(`Invalid forecast spec — ${fmtZod(parsed.error)}`);
    const result = runForecast(parsed.data, ds);
    return [{ type: "forecast", answer: composeForecastAnswer(result), result }];
  }
  if (name === "ask_clarification") {
    const parsed = ClarifySchema.safeParse(input);
    if (!parsed.success) throw new Error(`Invalid clarification — ${fmtZod(parsed.error)}`);
    return [{ type: "clarify", ...parsed.data }];
  }
  throw new Error(`Unknown tool '${name}'.`);
}

const errorText = (e: unknown) => (e instanceof QueryValidationError ? e.issues.join(" ") : e instanceof Error ? e.message : String(e));

let client: Groq | null = null;
export const aiConfigured = () => Boolean(process.env.GROQ_API_KEY);

export async function ask(question: string, prior?: PriorTurn | null): Promise<AskResponse> {
  const started = Date.now();
  const ds = getDataset();
  const calls: ToolCallTrace[] = [];

  const key = cacheKey(question, prior);
  const hit = planCache.get(key);
  if (hit) {
    const cards = hit.flatMap((c) => {
      calls.push({ tool: c.name, input: c.input, status: "executed" });
      return executeToolCall(c.name, c.input, ds);
    });
    return { question, cards, trace: { model: MODEL, attempts: 0, calls, cached: true, latencyMs: Date.now() - started } };
  }

  client ??= new Groq();
  let modelUsed = MODEL;
  const userText = prior
    ? `Previous question (for context only): ${prior.question}\nPrevious tool call: ${JSON.stringify(prior.plan)}\n\nCurrent question: ${question}`
    : question;
  const messages: ChatCompletionMessageParam[] = [
    { role: "system", content: buildSystemPrompt(ds) },
    { role: "user", content: userText },
  ];

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const response = await complete(messages);

    const message = response.choices[0]?.message;
    const toolCalls = message?.tool_calls ?? [];
    if (!toolCalls.length) {
      // The model's free text is never shown as an answer (it could contain invented numbers).
      return done([{ type: "unsupported", message: "That question can't be answered from this dataset. It covers orders, delivery status and dates, carriers, routes, regions, warehouses, products, quantities and order values." }], attempt);
    }

    const cards: Card[] = [];
    const results: { id: string; content: string; isError: boolean }[] = [];
    const accepted: { name: string; input: unknown }[] = [];
    for (const tc of toolCalls.slice(0, MAX_TOOL_CALLS)) {
      const name = tc.function.name;
      let input: unknown = tc.function.arguments;
      try {
        try {
          input = JSON.parse(tc.function.arguments || "{}");
        } catch {
          throw new Error("Arguments were not valid JSON.");
        }
        cards.push(...executeToolCall(name, input, ds));
        calls.push({ tool: name, input, status: "executed" });
        accepted.push({ name, input });
        results.push({ id: tc.id, content: "ok", isError: false });
      } catch (e) {
        const msg = errorText(e);
        calls.push({ tool: name, input, status: "rejected", error: msg });
        results.push({ id: tc.id, content: `Error: ${msg}`, isError: true });
      }
    }
    // Every tool call needs a matching tool message if we continue the conversation.
    for (const tc of toolCalls.slice(MAX_TOOL_CALLS))
      results.push({ id: tc.id, content: `Error: skipped, at most ${MAX_TOOL_CALLS} calls are allowed.`, isError: true });

    const anyRejected = results.some((r) => r.isError);
    if (!anyRejected || attempt === MAX_ATTEMPTS) {
      if (!anyRejected) {
        if (planCache.size >= CACHE_LIMIT) planCache.delete(planCache.keys().next().value!);
        planCache.set(key, accepted);
      }
      if (!cards.length)
        cards.push({ type: "unsupported", message: `I couldn't build a valid query for that. ${calls.filter((c) => c.error).map((c) => c.error).pop() ?? ""}` });
      return done(cards, attempt);
    }

    messages.push({ role: "assistant", content: message?.content ?? null, tool_calls: toolCalls });
    for (const r of results) messages.push({ role: "tool", tool_call_id: r.id, content: r.content });
    messages.push({ role: "user", content: "Some calls were rejected by validation. Re-issue ALL calls needed to answer the question, fixing the errors." });
  }
  return done([], MAX_ATTEMPTS);

  /** One completion, trying each model in turn while the previous one is rate-limited. */
  async function complete(msgs: ChatCompletionMessageParam[]) {
    let lastError: unknown;
    for (const model of MODELS) {
      try {
        const res = await client!.chat.completions.create(
          {
            model,
            messages: msgs,
            tools: TOOLS,
            tool_choice: "auto",
            parallel_tool_calls: true,
            temperature: 0,
            max_tokens: 2048,
            ...(model.startsWith("openai/gpt-oss") ? { reasoning_effort: EFFORT } : {}),
          },
          { maxRetries: 0 },
        );
        modelUsed = model;
        return res;
      } catch (e) {
        // Quota, provider outage or network failure on this model -> try the next one.
        if (!(e instanceof Groq.RateLimitError || e instanceof Groq.InternalServerError || e instanceof Groq.APIConnectionError)) throw e;
        lastError = e;
      }
    }
    throw lastError;
  }

  function done(cards: Card[], attempts: number): AskResponse {
    return { question, cards, trace: { model: modelUsed, attempts, calls, cached: false, latencyMs: Date.now() - started } };
  }
}
