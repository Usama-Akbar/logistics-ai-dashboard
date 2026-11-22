"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import Dashboard, { type Meta } from "./Dashboard";
import AskPanel from "./AskPanel";
import ForecastPanel from "./ForecastPanel";

type View = "dashboard" | "ask" | "forecast";
const VIEWS: { key: View; label: string }[] = [
  { key: "dashboard", label: "Dashboard" },
  { key: "ask", label: "Ask the data" },
  { key: "forecast", label: "Forecast" },
];

function subscribeHash(cb: () => void) {
  window.addEventListener("hashchange", cb);
  return () => window.removeEventListener("hashchange", cb);
}

export default function App() {
  const hash = useSyncExternalStore(subscribeHash, () => window.location.hash.slice(1), () => "");
  const view: View = VIEWS.some((v) => v.key === hash) ? (hash as View) : "dashboard";
  const [meta, setMeta] = useState<Meta | null>(null);

  useEffect(() => {
    fetch("/api/meta")
      .then((r) => r.json())
      .then(setMeta)
      .catch(() => setMeta(null));
  }, []);

  const go = (v: View) => {
    history.pushState(null, "", `#${v}`);
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  };

  return (
    <div className="mx-auto flex min-h-dvh max-w-7xl flex-col px-4 sm:px-6">
      <header className="flex flex-wrap items-center gap-4 py-5">
        <div className="mr-auto">
          <h1 className="text-lg font-semibold tracking-tight">Logistics Analytics</h1>
          <p className="text-xs text-ink-3">
            {meta ? `${meta.quality.rows} orders · ${meta.quality.orderDateRange.min} to ${meta.quality.orderDateRange.max}` : "Loading dataset…"}
          </p>
        </div>
        <nav className="flex rounded-lg border border-line bg-surface p-1" aria-label="Views">
          {VIEWS.map((v) => (
            <button
              key={v.key}
              onClick={() => go(v.key)}
              aria-current={view === v.key ? "page" : undefined}
              className={`rounded-md px-3 py-1.5 text-sm font-medium ${view === v.key ? "bg-accent-soft text-accent" : "text-ink-2 hover:text-ink"}`}
            >
              {v.label}
            </button>
          ))}
        </nav>
      </header>
      <main className="flex-1 pb-12">
        {view === "dashboard" && <Dashboard meta={meta} />}
        {view === "ask" && <AskPanel aiConfigured={meta ? meta.ai.configured : null} />}
        {view === "forecast" && <ForecastPanel categories={meta?.dimensions.product_category ?? []} />}
      </main>
      <footer className="border-t border-line py-4 text-center text-[11px] text-ink-3">
        Numbers are computed in code from the read-only dataset; the AI model only interprets questions into validated query plans. Built with AI assistance — see README.
      </footer>
    </div>
  );
}
