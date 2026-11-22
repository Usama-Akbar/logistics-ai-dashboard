/**
 * Small, dependency-free forecasting methods. Each takes a history and a
 * horizon and returns point forecasts. Kept deliberately simple: with 12
 * monthly points, anything fancier would overfit.
 */

export type MethodName = "moving_average" | "linear_regression" | "exponential_smoothing";

export interface MethodFit {
  forecast: number[];
  params: Record<string, number>;
}

export const MA_WINDOW = 3;

export function movingAverage(y: number[], h: number, window = MA_WINDOW): MethodFit {
  const w = Math.min(window, y.length);
  const tail = y.slice(-w);
  const level = tail.reduce((a, b) => a + b, 0) / w;
  return { forecast: Array(h).fill(level), params: { window: w } };
}

export function linearRegression(y: number[], h: number): MethodFit {
  const n = y.length;
  if (n < 2) return { forecast: Array(h).fill(y[0] ?? 0), params: { intercept: y[0] ?? 0, slope: 0 } };
  const xs = y.map((_, i) => i);
  const mx = (n - 1) / 2;
  const my = y.reduce((a, b) => a + b, 0) / n;
  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < n; i++) {
    sxy += (xs[i] - mx) * (y[i] - my);
    sxx += (xs[i] - mx) ** 2;
  }
  const slope = sxy / sxx;
  const intercept = my - slope * mx;
  const forecast = Array.from({ length: h }, (_, k) => Math.max(0, intercept + slope * (n + k)));
  return { forecast, params: { intercept, slope } };
}

/** Simple exponential smoothing; alpha chosen by minimising in-sample one-step SSE on a 0.05 grid. */
export function exponentialSmoothing(y: number[], h: number, alpha?: number): MethodFit {
  const run = (a: number) => {
    let level = y[0];
    let sse = 0;
    for (let i = 1; i < y.length; i++) {
      sse += (y[i] - level) ** 2;
      level = a * y[i] + (1 - a) * level;
    }
    return { level, sse };
  };
  let best = alpha ?? 0.5;
  if (alpha === undefined) {
    let bestSse = Infinity;
    for (let a = 0.05; a <= 0.951; a += 0.05) {
      const { sse } = run(a);
      if (sse < bestSse - 1e-9) {
        bestSse = sse;
        best = Math.round(a * 100) / 100;
      }
    }
  }
  const { level } = run(best);
  return { forecast: Array(h).fill(level), params: { alpha: best } };
}

export const METHODS: Record<MethodName, (y: number[], h: number) => MethodFit> = {
  moving_average: movingAverage,
  linear_regression: linearRegression,
  exponential_smoothing: exponentialSmoothing,
};

export const METHOD_LABELS: Record<MethodName, string> = {
  moving_average: `${MA_WINDOW}-month moving average`,
  linear_regression: "Linear trend (least squares)",
  exponential_smoothing: "Simple exponential smoothing",
};

export interface Backtest {
  mae: number;
  rmse: number;
  folds: number;
}

/**
 * Rolling-origin backtest: for each of the last `folds` months, fit on all
 * earlier months and predict one step ahead. Honest out-of-sample error.
 */
export function backtest(y: number[], method: MethodName, folds = 4, minTrain = 6): Backtest {
  const errs: number[] = [];
  for (let t = Math.max(minTrain, y.length - folds); t < y.length; t++) {
    const pred = METHODS[method](y.slice(0, t), 1).forecast[0];
    errs.push(y[t] - pred);
  }
  if (!errs.length) return { mae: NaN, rmse: NaN, folds: 0 };
  const mae = errs.reduce((a, e) => a + Math.abs(e), 0) / errs.length;
  const rmse = Math.sqrt(errs.reduce((a, e) => a + e * e, 0) / errs.length);
  return { mae, rmse, folds: errs.length };
}

/** Inverse standard normal CDF (Acklam's approximation) for safety-stock z-scores. */
export function zScore(p: number): number {
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const pl = 0.02425;
  if (p < pl) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p > 1 - pl) return -zScore(1 - p);
  const q = p - 0.5;
  const r = q * q;
  return ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}
