import { z } from "zod";
import { CATEGORICAL_DIMENSIONS, GROUP_BYS, METRICS } from "./semantic";
import { TIME_PRESETS } from "./time";

/**
 * The structured query contract between the AI interpreter and the engine.
 * The model never writes SQL or code; it can only fill this schema, which is
 * validated before anything is computed.
 */

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "dates must be YYYY-MM-DD");

export const TimeRangeSchema = z.strictObject({
  preset: z.enum(TIME_PRESETS).describe(
    "Relative presets resolve against the dataset's latest order date (NOT today's date). 'last_n_months' = N full calendar months ending with the latest month; 'previous_month' = 'last month'. Use 'custom' with start/end for explicit dates, months, or quarters.",
  ),
  n: z.number().int().min(1).max(366).nullable().describe("Number of periods for last_n_* presets; otherwise null."),
  start: isoDate.nullable().describe("Inclusive YYYY-MM-DD start for preset 'custom'; otherwise null."),
  end: isoDate.nullable().describe("Inclusive YYYY-MM-DD end for preset 'custom'; otherwise null."),
});

export const FilterSchema = z.strictObject({
  dimension: z.enum(CATEGORICAL_DIMENSIONS),
  values: z.array(z.string()).min(1).max(50).describe("Values to keep (OR within a dimension). Use exact values from the catalog."),
});

export const QuerySpecSchema = z.strictObject({
  intent_summary: z
    .string()
    .max(300)
    .describe("One sentence restating what will be computed, in business terms. Must not contain any numbers about the data."),
  metrics: z
    .array(z.enum(METRICS))
    .min(1)
    .max(3)
    .describe("1-3 metrics. The first metric is the primary one used for sorting and the headline answer."),
  group_by: z.enum(GROUP_BYS).describe("'none' for a single number; a time grain for trends; a dimension for breakdowns/rankings."),
  date_field: z
    .enum(["order_date", "delivery_date"])
    .describe("Which date the time range and time grain apply to. Use delivery_date for questions about when things were delivered."),
  time_range: TimeRangeSchema,
  filters: z.array(FilterSchema).max(6).describe("Categorical filters (AND across dimensions). Empty array for none."),
  promo_only: z.boolean().nullable().describe("true = only promo orders, false = only non-promo orders, null = all."),
  sort: z.enum(["auto", "desc", "asc"]).describe("'auto' = chronological for time grains, highest-first for dimensions."),
  limit: z.number().int().min(1).max(100).nullable().describe("Top-N limit for dimension breakdowns (e.g. 'top 5'); null for all."),
});

export type QuerySpec = z.infer<typeof QuerySpecSchema>;

/** What the AI tool receives: one query per part of the question, so compound questions fit in one call. */
export const QueryBatchSchema = z.strictObject({
  queries: z
    .array(QuerySpecSchema)
    .min(1)
    .max(3)
    .describe(
      "One query per part of the question. Usually exactly 1. Use 2-3 only when parts need a different grouping or different filters (e.g. 'on-time rate for FedEx AND average delivery time by region' = 2 queries).",
    ),
});
export type TimeRange = z.infer<typeof TimeRangeSchema>;

export const ForecastSpecSchema = z.strictObject({
  intent_summary: z.string().max(300).describe("One sentence restating what will be forecast. No numbers about the data."),
  sku: z.string().nullable().describe("SKU code like 'PENCIL-0076' if the user named one; otherwise null."),
  product_category: z.string().nullable().describe("Category like 'CRAYON' if the user named one; otherwise null. Null + null sku = total demand."),
  horizon_months: z.number().int().min(1).max(12).describe("Months to forecast. Default 3 if not specified."),
  method: z
    .enum(["auto", "moving_average", "linear_regression", "exponential_smoothing"])
    .describe("'auto' picks the method with the lowest backtest error. Only set another value if the user asks for it."),
  service_level: z
    .number()
    .min(0.5)
    .max(0.999)
    .nullable()
    .describe("Target probability of not stocking out, for safety stock (e.g. 0.95). Null = default 0.95."),
});

export type ForecastSpec = z.infer<typeof ForecastSpecSchema>;

export const ClarifySchema = z.strictObject({
  question: z.string().max(300).describe("A short clarifying question for the user."),
  options: z
    .array(z.string().max(120))
    .min(2)
    .max(4)
    .describe("2-4 complete, self-contained questions the user can click, each answerable by one tool call."),
});

export type ClarifySpec = z.infer<typeof ClarifySchema>;
