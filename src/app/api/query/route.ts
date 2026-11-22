import { NextResponse } from "next/server";
import { z } from "zod";
import { getDataset } from "@/lib/data/orders";
import { QuerySpecSchema } from "@/lib/analytics/querySpec";
import { executeQuery, QueryValidationError } from "@/lib/analytics/engine";
import { chooseChart, composeAnswer } from "@/lib/analytics/present";

/** Direct structured-query endpoint used by the dashboard (same engine the AI tool uses). */
const Body = z.object({ specs: z.array(QuerySpecSchema).min(1).max(12) });

export async function POST(req: Request) {
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") }, { status: 400 });
  try {
    const ds = getDataset();
    const results = parsed.data.specs.map((s) => {
      const result = executeQuery(s, ds);
      return { result, chart: chooseChart(result), answer: composeAnswer(result) };
    });
    return NextResponse.json({ results });
  } catch (e) {
    if (e instanceof QueryValidationError) return NextResponse.json({ error: e.message }, { status: 422 });
    throw e;
  }
}
