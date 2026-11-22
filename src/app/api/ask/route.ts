import Groq from "groq-sdk";
import { NextResponse } from "next/server";
import { z } from "zod";
import { aiConfigured, ask } from "@/lib/ai/orchestrator";
import { rateLimit } from "@/lib/rateLimit";

export const maxDuration = 60;

const Body = z.object({
  question: z.string().trim().min(3).max(400),
  prior: z.object({ question: z.string().max(400), plan: z.unknown() }).nullable().optional(),
});

export async function POST(req: Request) {
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Please enter a question (3–400 characters)." }, { status: 400 });
  if (!aiConfigured())
    return NextResponse.json({ error: "The AI interpreter is not configured on this server (GROQ_API_KEY missing). The dashboard still works." }, { status: 503 });

  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "local";
  if (!rateLimit(ip)) return NextResponse.json({ error: "Too many questions in the last minute — please wait a moment." }, { status: 429 });

  try {
    return NextResponse.json(await ask(parsed.data.question, parsed.data.prior ?? null));
  } catch (e) {
    if (e instanceof Groq.RateLimitError) return NextResponse.json({ error: "The AI provider is rate-limiting requests. Try again shortly." }, { status: 503 });
    if (e instanceof Groq.AuthenticationError) return NextResponse.json({ error: "The AI provider rejected the server's API key." }, { status: 503 });
    if (e instanceof Groq.APIError) return NextResponse.json({ error: `AI provider error (${e.status ?? "network"}). Try again.` }, { status: 502 });
    console.error(e);
    return NextResponse.json({ error: "Unexpected server error." }, { status: 500 });
  }
}
