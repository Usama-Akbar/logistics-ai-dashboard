"use client";

import type { Card } from "@/lib/ai/orchestrator";
import { ForecastChart, ResultChart } from "./charts";
import { ForecastExplain, QueryExplain } from "./Explain";

/** Renders **bold** only — answers are app-generated text, never HTML. */
export function Rich({ text }: { text: string }) {
  return (
    <>
      {text.split(/(\*\*[^*]+\*\*)/g).map((part, i) =>
        part.startsWith("**") && part.endsWith("**") ? (
          <strong key={i} className="font-semibold text-ink">
            {part.slice(2, -2)}
          </strong>
        ) : (
          <span key={i}>{part}</span>
        ),
      )}
    </>
  );
}

export function Warnings({ items }: { items: string[] }) {
  if (!items.length) return null;
  return (
    <ul className="mt-3 space-y-1 rounded-md px-3 py-2 text-xs" style={{ background: "var(--warn-bg)", color: "var(--warn-text)" }}>
      {items.map((w, i) => (
        <li key={i}>⚠ {w}</li>
      ))}
    </ul>
  );
}

export function ResultCard({ card, onPick }: { card: Card; onPick: (q: string) => void }) {
  if (card.type === "clarify")
    return (
      <div>
        <p className="text-sm text-ink-2">{card.question}</p>
        <div className="mt-3 flex flex-wrap gap-2">
          {card.options.map((o) => (
            <button key={o} onClick={() => onPick(o)} className="rounded-full border border-line bg-surface px-3 py-1.5 text-xs text-ink-2 hover:border-accent hover:text-accent">
              {o}
            </button>
          ))}
        </div>
      </div>
    );

  if (card.type === "unsupported") return <p className="text-sm text-ink-2">{card.message}</p>;

  if (card.type === "forecast") {
    const f = card.result;
    const r = f.recommendation;
    return (
      <div>
        <p className="text-sm leading-relaxed text-ink-2">
          <Rich text={card.answer} />
        </p>
        <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
          {[
            [`Demand, next ${r.horizonMonths} mo`, `${r.horizonDemand}`],
            ["Safety stock", `${r.safetyStock}`],
            ["Recommended inventory", `${r.recommendedInventory}`],
            ...(f.skuAllocation ? [[`For ${f.skuAllocation.sku}`, `${f.skuAllocation.recommendedInventory}`]] : [["Service level", `${(r.serviceLevel * 100).toFixed(0)}%`]]),
          ].map(([k, v]) => (
            <div key={k} className="rounded-lg bg-surface-2/60 px-3 py-2">
              <div className="text-[11px] text-ink-3">{k}</div>
              <div className="text-lg font-semibold tabular">{v}</div>
            </div>
          ))}
        </div>
        <div className="mt-4">
          <ForecastChart result={f} />
        </div>
        <Warnings items={f.warnings} />
        <ForecastExplain result={f} />
      </div>
    );
  }

  return (
    <div>
      <p className="text-sm leading-relaxed text-ink-2">
        <Rich text={card.answer} />
      </p>
      <div className="mt-4">
        <ResultChart result={card.result} chart={card.chart} />
      </div>
      <Warnings items={card.result.warnings} />
      <QueryExplain result={card.result} chart={card.chart} />
    </div>
  );
}
