import type { Dataset } from "@/lib/data/orders";
import { canonicalizeValue, knownValues, QueryValidationError } from "@/lib/analytics/engine";
import type { ForecastSpec } from "@/lib/analytics/querySpec";
import { addMonths, bucketLabel, enumerateBuckets, startOfMonth } from "@/lib/analytics/time";
import { backtest, METHOD_LABELS, METHODS, type MethodName, zScore } from "./methods";

export interface ForecastPoint {
  month: string;
  label: string;
  units: number;
  lower?: number;
  upper?: number;
}

export interface ForecastResult {
  kind: "forecast";
  spec: ForecastSpec;
  target: { level: "total" | "category" | "sku"; label: string };
  skuAllocation: null | { sku: string; category: string; skuUnits: number; categoryUnits: number; orders: number; share: number; recommendedInventory: number; horizonDemand: number };
  history: ForecastPoint[];
  forecast: ForecastPoint[];
  method: MethodName;
  methodLabel: string;
  methodsCompared: { method: MethodName; label: string; mae: number; rmse: number; params: Record<string, number>; selected: boolean }[];
  recommendation: { horizonMonths: number; horizonDemand: number; safetyStock: number; recommendedInventory: number; serviceLevel: number; z: number };
  methodology: string[];
  warnings: string[];
}

/** SKUs need at least this many months with demand before we model them on their own. */
export const MIN_ACTIVE_MONTHS_FOR_SKU = 6;

export function runForecast(spec: ForecastSpec, ds: Dataset): ForecastResult {
  const { orders, asOfDate } = ds;
  const warnings: string[] = [];
  const demand = orders.filter((o) => o.status !== "canceled");

  let sku: string | null = null;
  let category: string | null = null;
  if (spec.sku) {
    sku = canonicalizeValue("sku", spec.sku, orders);
    if (!sku) {
      const prefix = spec.sku.split("-")[0]?.toUpperCase() ?? "";
      const similar = knownValues("sku", orders).filter((s) => s.startsWith(prefix)).slice(0, 8);
      throw new QueryValidationError([`SKU '${spec.sku}' does not exist in the dataset.${similar.length ? ` Examples of real SKUs: ${similar.join(", ")}.` : ""}`]);
    }
  }
  if (spec.product_category) {
    category = canonicalizeValue("product_category", spec.product_category, orders);
    if (!category)
      throw new QueryValidationError([`Category '${spec.product_category}' does not exist. Known: ${knownValues("product_category", orders).join(", ")}.`]);
  }

  const months = enumerateBuckets(startOfMonth(ds.quality.orderDateRange.min), asOfDate, "month");
  const seriesFor = (pred: (o: (typeof demand)[number]) => boolean) => {
    const m = new Map(months.map((k) => [k, 0]));
    for (const o of demand) if (pred(o)) m.set(startOfMonth(o.order_date), (m.get(startOfMonth(o.order_date)) ?? 0) + o.quantity);
    return months.map((k) => m.get(k) ?? 0);
  };

  let level: ForecastResult["target"]["level"] = "total";
  let label = "All products";
  let y: number[];
  let skuInfo: { units: number; orders: number; activeMonths: number } | null = null;

  if (sku) {
    const skuSeries = seriesFor((o) => o.sku === sku);
    const skuCategory = orders.find((o) => o.sku === sku)!.product_category;
    skuInfo = {
      units: skuSeries.reduce((a, b) => a + b, 0),
      orders: demand.filter((o) => o.sku === sku).length,
      activeMonths: skuSeries.filter((v) => v > 0).length,
    };
    if (skuInfo.activeMonths >= MIN_ACTIVE_MONTHS_FOR_SKU) {
      level = "sku";
      label = sku;
      y = skuSeries;
    } else {
      category = skuCategory;
      level = "category";
      label = `${skuCategory} category (for SKU ${sku})`;
      y = seriesFor((o) => o.product_category === skuCategory);
      warnings.push(
        `SKU ${sku} has only ${skuInfo.orders} order(s) in ${skuInfo.activeMonths} of ${months.length} months — too sparse to forecast on its own. The ${skuCategory} category is forecast instead and the SKU's historical share of category units is used to size its inventory.`,
      );
    }
  } else if (category) {
    level = "category";
    label = `${category} category`;
    y = seriesFor((o) => o.product_category === category);
  } else {
    y = seriesFor(() => true);
  }

  const h = spec.horizon_months;
  const compared = (Object.keys(METHODS) as MethodName[]).map((m) => {
    const bt = backtest(y, m);
    return { method: m, label: METHOD_LABELS[m], mae: bt.mae, rmse: bt.rmse, folds: bt.folds, params: METHODS[m](y, h).params, selected: false };
  });
  const method: MethodName =
    spec.method === "auto" ? compared.reduce((a, b) => (b.mae < a.mae ? b : a)).method : spec.method;
  compared.forEach((c) => (c.selected = c.method === method));
  const chosen = compared.find((c) => c.method === method)!;

  const serviceLevel = spec.service_level ?? 0.95;
  const z = zScore(serviceLevel);
  const point = METHODS[method](y, h).forecast;
  const sigma = Number.isFinite(chosen.rmse) ? chosen.rmse : 0;

  const forecast: ForecastPoint[] = point.map((v, k) => {
    const month = addMonths(asOfDate, k + 1);
    const band = z * sigma * Math.sqrt(k + 1);
    return { month, label: bucketLabel(month, "month"), units: round1(v), lower: round1(Math.max(0, v - band)), upper: round1(v + band) };
  });
  const horizonDemand = point.reduce((a, b) => a + b, 0);
  // Errors of a sum of h one-step forecasts grow ~ sqrt(h) if independent.
  const safetyStock = z * sigma * Math.sqrt(h);
  const recommendedInventory = Math.ceil(horizonDemand + safetyStock);

  let skuAllocation: ForecastResult["skuAllocation"] = null;
  if (sku && level === "category" && skuInfo) {
    const categoryUnits = y.reduce((a, b) => a + b, 0);
    const share = categoryUnits ? skuInfo.units / categoryUnits : 0;
    skuAllocation = {
      sku,
      category: category!,
      skuUnits: skuInfo.units,
      categoryUnits,
      orders: skuInfo.orders,
      share,
      horizonDemand: round1(horizonDemand * share),
      recommendedInventory: Math.ceil(recommendedInventory * share),
    };
  }

  if (y.length < 12) warnings.push(`Only ${y.length} months of history — forecast uncertainty is high.`);
  const mean = y.reduce((a, b) => a + b, 0) / y.length;
  const spike = y.findIndex((v) => v > mean * 1.8);
  if (spike >= 0) warnings.push(`${bucketLabel(months[spike], "month")} is an outlier (${y[spike]} units vs. a ${mean.toFixed(0)}-unit monthly mean) and pulls trend-based methods.`);

  const methodology = [
    `Demand = units ordered per calendar month (sum of quantity by order_date), excluding canceled orders. History: ${bucketLabel(months[0], "month")} – ${bucketLabel(months[months.length - 1], "month")} (${y.length} months, empty months counted as 0).`,
    `Three methods were backtested with a rolling origin: for each of the last ${chosen.folds} months, fit on all earlier months and predict one month ahead. ${spec.method === "auto" ? `${chosen.label} had the lowest mean absolute error (MAE ${chosen.mae.toFixed(1)} units) and was selected.` : `${chosen.label} was used as requested.`}`,
    `Safety stock = z × RMSE × √horizon = ${z.toFixed(2)} × ${sigma.toFixed(1)} × √${h} = ${safetyStock.toFixed(1)} units, for a ${(serviceLevel * 100).toFixed(1)}% service level (z from the normal distribution; RMSE is the backtest one-step error).`,
    `Recommended inventory = forecast demand over ${h} month(s) (${horizonDemand.toFixed(1)}) + safety stock, rounded up = ${recommendedInventory} units.`,
    ...(skuAllocation
      ? [`SKU sizing: ${skuAllocation.sku} accounted for ${skuAllocation.skuUnits} of ${skuAllocation.categoryUnits} ${skuAllocation.category} units (${(skuAllocation.share * 100).toFixed(1)}%), so its plan is that share of the category plan.`]
      : []),
    "Shaded band ≈ forecast ± z × RMSE × √(months ahead); it assumes errors are independent and roughly normal.",
  ];

  return {
    kind: "forecast",
    spec,
    target: { level, label },
    skuAllocation,
    history: months.map((m, i) => ({ month: m, label: bucketLabel(m, "month"), units: y[i] })),
    forecast,
    method,
    methodLabel: chosen.label,
    methodsCompared: compared.map((c) => ({ method: c.method, label: c.label, selected: c.selected, mae: round1(c.mae), rmse: round1(c.rmse), params: roundParams(c.params) })),
    recommendation: { horizonMonths: h, horizonDemand: round1(horizonDemand), safetyStock: round1(safetyStock), recommendedInventory, serviceLevel, z: Math.round(z * 1000) / 1000 },
    methodology,
    warnings,
  };
}

const round1 = (v: number) => Math.round(v * 10) / 10;
const roundParams = (p: Record<string, number>) => Object.fromEntries(Object.entries(p).map(([k, v]) => [k, Math.round(v * 1000) / 1000]));

export function composeForecastAnswer(f: ForecastResult): string {
  const r = f.recommendation;
  const months = f.forecast.map((p) => `${p.label}: ${p.units}`).join(", ");
  let text = `Forecast for **${f.target.label}** using ${f.methodLabel.toLowerCase()}: ${months} units (≈ **${r.horizonDemand}** over ${r.horizonMonths} month${r.horizonMonths > 1 ? "s" : ""}). Plan **${r.recommendedInventory} units** of inventory — forecast plus ${r.safetyStock} units of safety stock for a ${(r.serviceLevel * 100).toFixed(0)}% service level.`;
  if (f.skuAllocation)
    text += ` For SKU **${f.skuAllocation.sku}** (${(f.skuAllocation.share * 100).toFixed(1)}% of ${f.skuAllocation.category} units historically) that is ≈ ${f.skuAllocation.horizonDemand} units of demand → stock **${f.skuAllocation.recommendedInventory} unit${f.skuAllocation.recommendedInventory === 1 ? "" : "s"}**.`;
  return text;
}
