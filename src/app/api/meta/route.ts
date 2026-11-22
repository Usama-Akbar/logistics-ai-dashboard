import { NextResponse } from "next/server";
import { connection } from "next/server";
import { getDataset } from "@/lib/data/orders";
import { knownValues } from "@/lib/analytics/engine";
import { CATEGORICAL_DIMENSIONS, METRIC_DEFS, METRICS } from "@/lib/analytics/semantic";
import { aiConfigured, MODEL } from "@/lib/ai/orchestrator";

export async function GET() {
  await connection();
  const ds = getDataset();
  return NextResponse.json({
    asOfDate: ds.asOfDate,
    quality: ds.quality,
    metrics: METRICS.map((m) => ({ key: m, label: METRIC_DEFS[m].label, format: METRIC_DEFS[m].format, definition: METRIC_DEFS[m].definition })),
    dimensions: Object.fromEntries(CATEGORICAL_DIMENSIONS.filter((d) => d !== "sku" && d !== "client_id").map((d) => [d, knownValues(d, ds.orders)])),
    ai: { configured: aiConfigured(), model: MODEL },
  });
}
