import { NextResponse } from "next/server";
import { getDataset } from "@/lib/data/orders";
import { ForecastSpecSchema } from "@/lib/analytics/querySpec";
import { QueryValidationError } from "@/lib/analytics/engine";
import { composeForecastAnswer, runForecast } from "@/lib/forecast/forecast";

export async function POST(req: Request) {
  const parsed = ForecastSpecSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") }, { status: 400 });
  try {
    const result = runForecast(parsed.data, getDataset());
    return NextResponse.json({ result, answer: composeForecastAnswer(result) });
  } catch (e) {
    if (e instanceof QueryValidationError) return NextResponse.json({ error: e.message }, { status: 422 });
    throw e;
  }
}
