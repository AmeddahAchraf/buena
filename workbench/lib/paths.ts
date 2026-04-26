import path from "node:path";
import fs from "node:fs";

// Resolve config paths from env, with sensible defaults that work
// when the workbench/ folder is a sibling of the dataset folders.
const here = process.cwd();

function resolveFromHere(p: string): string {
  if (path.isAbsolute(p)) return p;
  // When running via next dev, cwd is workbench/. Resolve relative to that.
  return path.resolve(here, p);
}

// Detect default dataset root: prefer ../ (parent of workbench/) if it
// contains the expected folders, otherwise fall back to cwd.
function detectDatasetRoot(): string {
  const candidates = [
    process.env.DATASET_ROOT,
    path.resolve(here, ".."),
    here,
  ].filter(Boolean) as string[];
  for (const c of candidates) {
    const abs = path.isAbsolute(c) ? c : path.resolve(here, c);
    if (
      fs.existsSync(path.join(abs, "stammdaten")) &&
      fs.existsSync(path.join(abs, "incremental"))
    ) {
      return abs;
    }
  }
  return resolveFromHere(process.env.DATASET_ROOT || "..");
}

export const DATASET_ROOT = detectDatasetRoot();
export const OUT_ROOT = resolveFromHere(
  process.env.OUT_ROOT || path.join(DATASET_ROOT, "out"),
);
export const CACHE_ROOT = resolveFromHere(
  process.env.CACHE_ROOT || path.join(DATASET_ROOT, ".workbench-cache"),
);

export const SUBFOLDERS = {
  stammdaten: "stammdaten",
  rechnungen: "rechnungen",
  emails: "emails",
  bank: "bank",
  briefe: "briefe",
  incremental: "incremental",
} as const;

export function ensureDir(p: string) {
  fs.mkdirSync(p, { recursive: true });
}

export function propertyOutDir(propertyId: string): string {
  return path.join(OUT_ROOT, propertyId);
}

export function relFromDataset(absPath: string): string {
  return path.relative(DATASET_ROOT, absPath);
}
