import fs from "node:fs";
import path from "node:path";
import { DATASET_ROOT, SUBFOLDERS } from "./paths";

const SKIP = new Set([
  ".DS_Store",
  "Thumbs.db",
  ".git",
  "out",
  ".workbench-cache",
  "workbench",
  "node_modules",
]);

export function* walk(dir: string): Generator<string> {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (SKIP.has(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      yield* walk(full);
    } else if (e.isFile()) {
      yield full;
    }
  }
}

export interface ScannedFile {
  abs: string;
  rel: string;
  bucket: "base" | "incremental";
  bucketSubfolder: string;
}

export function scanBase(): ScannedFile[] {
  const out: ScannedFile[] = [];
  for (const sf of [
    SUBFOLDERS.stammdaten,
    SUBFOLDERS.bank,
    SUBFOLDERS.emails,
    SUBFOLDERS.rechnungen,
    SUBFOLDERS.briefe,
  ]) {
    const dir = path.join(DATASET_ROOT, sf);
    if (!fs.existsSync(dir)) continue;
    for (const f of walk(dir)) {
      out.push({
        abs: f,
        rel: path.relative(DATASET_ROOT, f),
        bucket: "base",
        bucketSubfolder: sf,
      });
    }
  }
  return out;
}

// Files that describe the *batch* (manifest, indexes) rather than the property.
const INCREMENTAL_HOUSEKEEPING = new Set([
  "incremental_manifest.json",
  "emails_index.csv",
  "rechnungen_index.csv",
  "bank_index.csv",
]);

export function scanIncremental(day?: string): ScannedFile[] {
  const root = path.join(DATASET_ROOT, SUBFOLDERS.incremental);
  const dir = day ? path.join(root, day) : root;
  const out: ScannedFile[] = [];
  if (!fs.existsSync(dir)) return out;
  for (const f of walk(dir)) {
    const base = path.basename(f);
    if (INCREMENTAL_HOUSEKEEPING.has(base)) continue;
    out.push({
      abs: f,
      rel: path.relative(DATASET_ROOT, f),
      bucket: "incremental",
      bucketSubfolder: day ? `incremental/${day}` : "incremental",
    });
  }
  return out;
}

export interface IncrementalDay {
  day: string;
  total_files: number;
  files_by_type: Record<string, number>;
  content_date?: string;
  difficulty?: string;
  emails_written?: number;
  invoices_written?: number;
  bank_transactions_written?: number;
}

export function listIncrementalDays(): IncrementalDay[] {
  const root = path.join(DATASET_ROOT, SUBFOLDERS.incremental);
  if (!fs.existsSync(root)) return [];
  const entries = fs.readdirSync(root, { withFileTypes: true });
  const days: IncrementalDay[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (!/^day-\d+$/.test(e.name)) continue;
    const dayDir = path.join(root, e.name);
    let count = 0;
    const byType: Record<string, number> = {};
    let manifest: Record<string, unknown> | null = null;
    for (const f of walk(dayDir)) {
      const base = path.basename(f);
      if (INCREMENTAL_HOUSEKEEPING.has(base)) {
        if (base === "incremental_manifest.json") {
          try {
            manifest = JSON.parse(fs.readFileSync(f, "utf8"));
          } catch {}
        }
        continue;
      }
      count++;
      const ext = path.extname(f).toLowerCase().replace(".", "") || "other";
      byType[ext] = (byType[ext] ?? 0) + 1;
    }
    days.push({
      day: e.name,
      total_files: count,
      files_by_type: byType,
      content_date: manifest?.content_date as string | undefined,
      difficulty: manifest?.difficulty as string | undefined,
      emails_written: manifest?.emails_written as number | undefined,
      invoices_written: manifest?.invoices_written as number | undefined,
      bank_transactions_written: manifest?.bank_transactions_written as
        | number
        | undefined,
    });
  }
  return days.sort((a, b) => a.day.localeCompare(b.day));
}
