"use client";

import { useEffect, useRef, useState } from "react";
import type { AskResponse } from "@/lib/ai/orchestrator";
import { ResultCard } from "./Cards";

interface Entry {
  id: number;
  question: string;
  status: "loading" | "done" | "error";
  response?: AskResponse;
  error?: string;
}

const EXAMPLES = [
  "Show delayed orders by week for the last 3 months",
  "Which carrier has the highest delay rate?",
  "How many orders were delivered late last month?",
  "Predict demand for SKU PENCIL-0076 for the next 4 months",
  "How much inventory should I plan for crayons next quarter?",
  "Average delivery time by warehouse in Q3",
  "Compare on-time rate and order volume by region",
  "Which carrier is best?",
];

const HISTORY_KEY = "logistics-ask-history";

function loadHistory(): string[] {
  try {
    return JSON.parse(localStorage.getItem(HISTORY_KEY) ?? "[]");
  } catch {
    return [];
  }
}

function saveHistory(h: string[]) {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(h.slice(0, 15)));
  } catch {
    /* storage unavailable (private mode) — history is a convenience only */
  }
}

function Trace({ r }: { r: AskResponse }) {
  const [open, setOpen] = useState(false);
  const t = r.trace;
  const rejected = t.calls.filter((c) => c.status === "rejected").length;
  return (
    <div className="mt-4 border-t border-line pt-3 text-[11px] text-ink-3">
      <button onClick={() => setOpen(!open)} className="hover:text-ink-2" aria-expanded={open}>
        {t.cached ? "Cached interpretation" : `Interpreted by ${t.model}`} · {t.calls.filter((c) => c.status === "executed").map((c) => c.tool).join(", ") || "no tool"}
        {rejected ? ` · ${rejected} call(s) rejected by validation & retried` : ""} · {(t.latencyMs / 1000).toFixed(1)}s · {open ? "hide trace" : "show trace"}
      </button>
      {open && (
        <ol className="mt-2 space-y-2">
          {t.calls.map((c, i) => (
            <li key={i} className="rounded-md bg-surface-2/60 p-2">
              <div className="font-medium text-ink-2">
                {i + 1}. {c.tool} — {c.status === "executed" ? "validated & executed" : "rejected"}
              </div>
              {c.error && <div className="mt-1 text-[var(--critical)]">{c.error}</div>}
              <pre className="mt-1 max-h-48 overflow-auto font-mono text-[10.5px] leading-relaxed">{JSON.stringify(c.input, null, 2)}</pre>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

export default function AskPanel({ aiConfigured }: { aiConfigured: boolean | null }) {
  const [q, setQ] = useState("");
  const [entries, setEntries] = useState<Entry[]>([]);
  const [history, setHistory] = useState<string[]>([]);
  const nextId = useRef(1);
  const busy = entries.some((e) => e.status === "loading");

  useEffect(() => setHistory(loadHistory()), []);

  async function submit(question: string) {
    const text = question.trim();
    if (!text || busy) return;
    const id = nextId.current++;
    const last = entries.find((e) => e.status === "done" && e.response?.trace.calls.some((c) => c.status === "executed"));
    const prior = last
      ? { question: last.question, plan: last.response!.trace.calls.filter((c) => c.status === "executed").map((c) => ({ tool: c.tool, input: c.input })) }
      : null;
    setEntries((es) => [{ id, question: text, status: "loading" }, ...es]);
    setQ("");
    const h = [text, ...history.filter((x) => x !== text)];
    setHistory(h);
    saveHistory(h);
    try {
      const res = await fetch("/api/ask", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ question: text, prior }) });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error ?? "Request failed");
      setEntries((es) => es.map((e) => (e.id === id ? { ...e, status: "done", response: j } : e)));
    } catch (err) {
      setEntries((es) => es.map((e) => (e.id === id ? { ...e, status: "error", error: (err as Error).message } : e)));
    }
  }

  return (
    <div className="grid gap-5 lg:grid-cols-[1fr_260px]">
      <div className="min-w-0 space-y-4">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            submit(q);
          }}
          className="card flex items-center gap-2 p-2"
        >
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Ask about orders, delays, carriers, delivery times or demand…"
            maxLength={400}
            className="min-w-0 flex-1 bg-transparent px-3 py-2 text-sm outline-none placeholder:text-ink-3"
            aria-label="Question"
          />
          <button type="submit" disabled={busy || !q.trim()} className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white disabled:opacity-40">
            {busy ? "Thinking…" : "Ask"}
          </button>
        </form>

        {aiConfigured === false && (
          <div className="card p-4 text-sm text-ink-2">
            The AI interpreter isn&apos;t configured on this deployment (no <code>GROQ_API_KEY</code>). The dashboard and forecast tabs work without it.
          </div>
        )}

        {entries.length === 0 && (
          <div className="card p-5">
            <p className="text-sm text-ink-2">
              Questions are interpreted by an AI model into a <strong className="font-semibold text-ink">validated structured query</strong>, then computed in code over the dataset. Every answer shows its filters, metric definitions, query plan and underlying data.
            </p>
            <div className="mt-4 flex flex-wrap gap-2">
              {EXAMPLES.map((e) => (
                <button key={e} onClick={() => submit(e)} className="rounded-full border border-line bg-surface px-3 py-1.5 text-xs text-ink-2 hover:border-accent hover:text-accent">
                  {e}
                </button>
              ))}
            </div>
          </div>
        )}

        {entries.map((e) => (
          <article key={e.id} className="card p-5">
            <h3 className="text-sm font-semibold">{e.question}</h3>
            <div className="mt-3">
              {e.status === "loading" && <div className="h-24 animate-pulse rounded-lg bg-surface-2" />}
              {e.status === "error" && <p className="text-sm text-[var(--critical)]">{e.error}</p>}
              {e.status === "done" &&
                e.response!.cards.map((c, i) => (
                  <div key={i} className={i ? "mt-6 border-t border-line pt-6" : ""}>
                    <ResultCard card={c} onPick={submit} />
                  </div>
                ))}
              {e.status === "done" && <Trace r={e.response!} />}
            </div>
          </article>
        ))}
      </div>

      <aside className="space-y-4">
        <div className="card p-4">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-3">Recent questions</h3>
          {history.length === 0 ? (
            <p className="mt-2 text-xs text-ink-3">Your questions will appear here (stored in this browser only).</p>
          ) : (
            <ul className="mt-2 space-y-1">
              {history.map((h) => (
                <li key={h}>
                  <button onClick={() => submit(h)} className="w-full truncate rounded px-1 py-1 text-left text-xs text-ink-2 hover:bg-surface-2" title={h}>
                    {h}
                  </button>
                </li>
              ))}
            </ul>
          )}
          {history.length > 0 && (
            <button
              onClick={() => {
                setHistory([]);
                saveHistory([]);
              }}
              className="mt-2 text-[11px] text-ink-3 hover:text-ink-2"
            >
              Clear history
            </button>
          )}
        </div>
        <div className="card p-4 text-xs text-ink-3">
          <h3 className="font-semibold uppercase tracking-wide">Tips</h3>
          <ul className="mt-2 list-disc space-y-1 pl-4">
            <li>Follow-ups work: “now by month”, “what about UPS?”.</li>
            <li>“Last month” means the month before the latest order in the data.</li>
            <li>Ambiguous questions get clarifying options instead of a guess.</li>
          </ul>
        </div>
      </aside>
    </div>
  );
}
