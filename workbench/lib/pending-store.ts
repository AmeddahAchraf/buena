import fs from "node:fs";
import path from "node:path";
import { CACHE_ROOT, ensureDir } from "./paths";
import type { PendingUpdate } from "./incremental";

// Pending updates live in a simple JSON file under .workbench-cache so
// the UI can preview / apply / reject them across requests without a DB.

const STORE = () => path.join(CACHE_ROOT, "pending.json");

interface PendingDoc {
  version: 1;
  updated_at: string;
  items: PendingUpdate[];
}

export function loadPending(): PendingDoc {
  ensureDir(CACHE_ROOT);
  if (!fs.existsSync(STORE())) {
    return { version: 1, updated_at: new Date().toISOString(), items: [] };
  }
  return JSON.parse(fs.readFileSync(STORE(), "utf8")) as PendingDoc;
}

export function savePending(items: PendingUpdate[]) {
  ensureDir(CACHE_ROOT);
  const doc: PendingDoc = {
    version: 1,
    updated_at: new Date().toISOString(),
    items,
  };
  fs.writeFileSync(STORE(), JSON.stringify(doc, null, 2));
}

export function mergePending(items: PendingUpdate[]) {
  // Replace any items with same source.id, append the rest
  const existing = loadPending().items;
  const byId = new Map<string, PendingUpdate>();
  for (const it of existing) byId.set(it.source.id, it);
  for (const it of items) byId.set(it.source.id, it);
  savePending([...byId.values()]);
}

export function removePending(sourceId: string) {
  const existing = loadPending().items;
  savePending(existing.filter((i) => i.source.id !== sourceId));
}

export function findPending(sourceId: string): PendingUpdate | null {
  return loadPending().items.find((i) => i.source.id === sourceId) ?? null;
}
