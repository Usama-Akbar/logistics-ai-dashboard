import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

/**
 * Data access layer. The CSV in /data is the single source of truth and is
 * treated as read-only: it is parsed once per server instance and every
 * consumer receives a frozen array.
 */

export const STATUSES = ["delivered", "delayed", "in_transit", "exception", "canceled"] as const;
export type Status = (typeof STATUSES)[number];

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD");

const RowSchema = z.object({
  client_id: z.string().min(1),
  order_id: z.string().min(1),
  order_date: isoDate,
  delivery_date: z.union([isoDate, z.literal("")]),
  carrier: z.string().min(1),
  origin_city: z.string().min(1),
  destination_city: z.string().min(1),
  status: z.enum(STATUSES),
  sku: z.string().min(1),
  product_category: z.string().min(1),
  quantity: z.coerce.number().int().nonnegative(),
  unit_price_usd: z.coerce.number().nonnegative(),
  order_value_usd: z.coerce.number().nonnegative(),
  is_promo: z.enum(["0", "1"]),
  promo_discount_pct: z.coerce.number().nonnegative(),
  region: z.string().min(1),
  warehouse: z.string().min(1),
});

export interface Order {
  client_id: string;
  order_id: string;
  order_date: string;
  delivery_date: string | null;
  /** Whole days between order_date and delivery_date; null when not delivered yet. */
  delivery_days: number | null;
  carrier: string;
  origin_city: string;
  destination_city: string;
  status: Status;
  sku: string;
  product_category: string;
  quantity: number;
  unit_price_usd: number;
  order_value_usd: number;
  is_promo: boolean;
  promo_discount_pct: number;
  region: string;
  warehouse: string;
}

export interface DataQualityReport {
  rows: number;
  rejected: { line: number; error: string }[];
  missingDeliveryDateByStatus: Record<string, number>;
  orderDateRange: { min: string; max: string };
  duplicateOrderIds: number;
  valueMismatches: number;
}

export interface Dataset {
  orders: readonly Order[];
  /** The "as of" date used to resolve relative ranges such as "last month". */
  asOfDate: string;
  quality: DataQualityReport;
}

/** Minimal RFC-4180 parser (quoted fields, escaped quotes, CRLF). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') {
        inQuotes = false;
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      if (row.some((f) => f !== "")) rows.push(row);
      row = [];
      field = "";
    } else {
      field += c;
    }
  }
  if (field !== "" || row.length) {
    row.push(field);
    if (row.some((f) => f !== "")) rows.push(row);
  }
  return rows;
}

export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

export function buildDataset(csvText: string): Dataset {
  const [header, ...lines] = parseCsv(csvText);
  const orders: Order[] = [];
  const rejected: DataQualityReport["rejected"] = [];
  const missingDeliveryDateByStatus: Record<string, number> = {};
  let valueMismatches = 0;

  lines.forEach((cells, idx) => {
    const raw = Object.fromEntries(header.map((h, i) => [h.trim(), (cells[i] ?? "").trim()]));
    const parsed = RowSchema.safeParse(raw);
    if (!parsed.success) {
      rejected.push({ line: idx + 2, error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });
      return;
    }
    const r = parsed.data;
    const delivery = r.delivery_date === "" ? null : r.delivery_date;
    if (!delivery) missingDeliveryDateByStatus[r.status] = (missingDeliveryDateByStatus[r.status] ?? 0) + 1;
    if (Math.abs(r.quantity * r.unit_price_usd - r.order_value_usd) > 0.011) valueMismatches++;
    orders.push(
      Object.freeze({
        ...r,
        delivery_date: delivery,
        delivery_days: delivery ? daysBetween(r.order_date, delivery) : null,
        is_promo: r.is_promo === "1",
      }),
    );
  });

  const dates = orders.map((o) => o.order_date).sort();
  const ids = new Set(orders.map((o) => o.order_id));
  return {
    orders: Object.freeze(orders),
    asOfDate: dates[dates.length - 1],
    quality: {
      rows: orders.length,
      rejected,
      missingDeliveryDateByStatus,
      orderDateRange: { min: dates[0], max: dates[dates.length - 1] },
      duplicateOrderIds: orders.length - ids.size,
      valueMismatches,
    },
  };
}

let cached: Dataset | null = null;

export function getDataset(): Dataset {
  if (!cached) {
    const file = path.join(process.cwd(), "data", "mock_logistics_data.csv");
    cached = buildDataset(fs.readFileSync(file, "utf8"));
  }
  return cached;
}
