import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock the Groq SDK: each test queues the responses the "model" will return.
const queue: unknown[] = [];
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- params type the mock.calls tuple
const create = vi.fn(async (_body?: unknown, _opts?: unknown) => {
  const next = queue.shift();
  if (next instanceof Error) throw next;
  return next;
});
vi.mock("groq-sdk", () => {
  class APIError extends Error {}
  class Groq {
    static APIError = APIError;
    static RateLimitError = class extends APIError {};
    static InternalServerError = class extends APIError {};
    static APIConnectionError = class extends APIError {};
    static AuthenticationError = class extends APIError {};
    chat = { completions: { create } };
  }
  return { default: Groq };
});
const { default: Groq } = await import("groq-sdk");

const { ask, TOOLS, MODELS } = await import("@/lib/ai/orchestrator");

type ToolCall = { id: string; type: "function"; function: { name: string; arguments: string } };
const toolUse = (name: string, input: unknown, id = "tu_1"): ToolCall => ({ id, type: "function", function: { name, arguments: JSON.stringify(input) } });
const reply = (...calls: ToolCall[]) => ({ choices: [{ message: { role: "assistant", content: null, tool_calls: calls } }] });
const textReply = (text: string) => ({ choices: [{ message: { role: "assistant", content: text } }] });
const q = (over: Record<string, unknown> = {}) => ({
  intent_summary: "Rank carriers by delay rate",
  metrics: ["delay_rate"],
  group_by: "carrier",
  date_field: "order_date",
  time_range: { preset: "all_time", n: null, start: null, end: null },
  filters: [],
  promo_only: null,
  sort: "desc",
  limit: null,
  ...over,
});

beforeEach(() => {
  queue.length = 0;
  create.mockClear();
});

describe("tool schemas", () => {
  it("are strict: every object closes additionalProperties and requires all its properties", () => {
    const walk = (node: unknown): void => {
      if (!node || typeof node !== "object") return;
      const n = node as Record<string, unknown>;
      if (n.type === "object") {
        expect(n.additionalProperties).toBe(false);
        expect(new Set(n.required as string[])).toEqual(new Set(Object.keys(n.properties as object)));
      }
      Object.values(n).forEach(walk);
    };
    for (const t of TOOLS) {
      expect(t.function!.strict).toBe(true);
      walk(t.function!.parameters);
      expect(JSON.stringify(t.function!.parameters)).not.toMatch(/"(minimum|maximum|pattern|minItems|\$schema)"/);
    }
  });
});

describe("orchestration", () => {
  it("routes to the query tool and answers from computed data", async () => {
    queue.push(reply(toolUse("query_analytics", { queries: [q()] })));
    const r = await ask("Which carrier has the highest delay rate?");
    expect(r.cards[0].type).toBe("query");
    if (r.cards[0].type === "query") expect(r.cards[0].answer).toMatch(/\*\*GLS\*\*/);
    expect(r.trace.attempts).toBe(1);
  });

  it("feeds validation errors back to the model and accepts the corrected call", async () => {
    queue.push(reply(toolUse("query_analytics", { queries: [q({ filters: [{ dimension: "carrier", values: ["Fed-Ex"] }] })] })));
    queue.push(reply(toolUse("query_analytics", { queries: [q({ filters: [{ dimension: "carrier", values: ["FedEx"] }] })] }, "tu_2")));
    const r = await ask("delay rate for fed-ex by carrier");
    expect(create).toHaveBeenCalledTimes(2);
    const second = (create.mock.calls[1] as unknown as [{ messages: { role: string; content: string; tool_call_id?: string }[] }])[0];
    const toolResult = second.messages.find((m) => m.role === "tool")!;
    expect(toolResult.tool_call_id).toBe("tu_1");
    expect(toolResult.content).toMatch(/^Error: .*not a known carrier/);
    expect(r.trace.calls.map((c) => c.status)).toEqual(["rejected", "executed"]);
    expect(r.cards[0].type).toBe("query");
  });

  it("never shows free text from the model as an answer", async () => {
    queue.push(textReply("Revenue was $1M last year."));
    const r = await ask("What was our marketing spend?");
    expect(r.cards).toEqual([{ type: "unsupported", message: expect.not.stringContaining("$1M") }]);
  });

  it("routes forecasts and clarifications", async () => {
    queue.push(reply(toolUse("forecast_demand", { intent_summary: "x", sku: null, product_category: "CRAYON", horizon_months: 3, method: "auto", service_level: null })));
    expect((await ask("How much crayon stock for next quarter?")).cards[0].type).toBe("forecast");
    queue.push(reply(toolUse("ask_clarification", { question: "Best by what?", options: ["Lowest delay rate by carrier", "Fastest average delivery time by carrier"] })));
    expect((await ask("Which carrier is best?")).cards[0].type).toBe("clarify");
  });

  it("answers compound questions with several queries in one call", async () => {
    queue.push(reply(toolUse("query_analytics", { queries: [q({ metrics: ["on_time_rate"], group_by: "none" }), q({ metrics: ["avg_delivery_days"], group_by: "region" })] })));
    const r = await ask("On-time rate overall and average delivery time by region");
    expect(r.cards.map((c) => c.type)).toEqual(["query", "query"]);
  });

  it("rejects malformed JSON arguments and retries", async () => {
    queue.push(reply({ id: "tu_1", type: "function", function: { name: "query_analytics", arguments: "{not json" } }));
    queue.push(reply(toolUse("query_analytics", { queries: [q()] }, "tu_2")));
    const r = await ask("Which carrier is slowest to deliver on time?");
    expect(r.trace.calls.map((c) => c.status)).toEqual(["rejected", "executed"]);
    expect(r.cards[0].type).toBe("query");
  });

  it("falls back to the next model when the primary one is rate-limited", async () => {
    queue.push(new (Groq as unknown as { RateLimitError: new (m: string) => Error }).RateLimitError("429"));
    queue.push(reply(toolUse("query_analytics", { queries: [q()] })));
    const r = await ask("Rank carriers by delay rate, worst first");
    const models = create.mock.calls.map((c) => (c[0] as { model: string }).model);
    expect(models).toEqual([MODELS[0], MODELS[1]]);
    expect(r.trace.model).toBe(MODELS[1]);
    expect(r.cards[0].type).toBe("query");
  });

  it("caches validated plans for repeated questions", async () => {
    queue.push(reply(toolUse("query_analytics", { queries: [q({ metrics: ["order_count"] })] })));
    await ask("Orders by carrier please");
    const again = await ask("  orders BY carrier please ");
    expect(create).toHaveBeenCalledTimes(1);
    expect(again.trace.cached).toBe(true);
  });
});
