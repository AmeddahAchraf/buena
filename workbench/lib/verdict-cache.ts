// Verdict cache: persisted JSON keyed by (content_hash + skill_hash + context_hash).
// Hits skip the AI call entirely on warm rebuilds; misses run the model and
// are written through. Stored outside CACHE_ROOT so build:all's clean-slate
// wipe doesn't blow it away — that's the whole point.
//
// We cache the raw AI response (AIClassifierResponse), not the finalised
// PatchDecision, because PatchDecision contains source-specific fields
// (citations, expires_at) and those must be re-derived per call.

import fs from "node:fs";
import path from "node:path";
import { DATASET_ROOT, ensureDir } from "./paths";
import { sha256 } from "./hash";

const CACHE_DIR = path.join(DATASET_ROOT, ".workbench-verdict-cache");
const CACHE_FILE = path.join(CACHE_DIR, "verdicts.json");

interface VerdictCacheEntry<T = unknown> {
  v: T;
  t: string; // saved_at ISO
}

let _cache: Record<string, VerdictCacheEntry> | null = null;
let _hits = 0;
let _misses = 0;

function load(): Record<string, VerdictCacheEntry> {
  if (_cache) return _cache;
  try {
    if (fs.existsSync(CACHE_FILE)) {
      _cache = JSON.parse(fs.readFileSync(CACHE_FILE, "utf8")) as Record<
        string,
        VerdictCacheEntry
      >;
      return _cache;
    }
  } catch {
    // corrupt cache → start over
  }
  _cache = {};
  return _cache;
}

export function makeVerdictKey(args: {
  checksum: string;
  skillHash: string;
  contextHash: string;
}): string {
  return sha256(
    `${args.checksum}|${args.skillHash}|${args.contextHash}`,
  ).slice(0, 24);
}

export function getCachedVerdict<T = unknown>(key: string): T | null {
  const c = load();
  const hit = c[key];
  if (hit) {
    _hits++;
    return hit.v as T;
  }
  _misses++;
  return null;
}

export function setCachedVerdict<T = unknown>(key: string, value: T): void {
  const c = load();
  c[key] = { v: value, t: new Date().toISOString() };
}

export function flushVerdictCache(): void {
  if (!_cache) return;
  ensureDir(CACHE_DIR);
  fs.writeFileSync(CACHE_FILE, JSON.stringify(_cache));
}

export function verdictCacheStats(): {
  entries: number;
  hits: number;
  misses: number;
} {
  return { entries: Object.keys(load()).length, hits: _hits, misses: _misses };
}

export function resetVerdictCacheStats(): void {
  _hits = 0;
  _misses = 0;
}
