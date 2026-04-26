import fs from "node:fs";
import path from "node:path";
import { loadIndex, normalizeEmail, normalizeUnit } from "./index-store";
import { OUT_ROOT, propertyOutDir } from "./paths";
import type { Entity } from "./types";

export interface SearchHit {
  property_id: string;
  property_name: string;
  matched_field: string;
  matched_value: string;
  entity_id?: string;
  entity_type?: string;
  entity_name?: string;
}

export async function search(query: string): Promise<SearchHit[]> {
  const idx = await loadIndex();
  const q = query.trim();
  if (!q) return [];
  const lower = q.toLowerCase();
  const hits: SearchHit[] = [];

  // exact id
  const upper = q.toUpperCase();
  if (idx.byId.has(upper)) {
    const e = idx.byId.get(upper)!;
    if (e.property_id) {
      const p = idx.properties.find((p) => p.id === e.property_id)!;
      hits.push(toHit(p, e, "id", upper));
    } else if (e.type === "property") {
      const p = idx.properties.find((p) => p.id === e.id)!;
      hits.push(toHit(p, e, "id", upper));
    }
  }

  // email
  if (q.includes("@")) {
    const id = idx.byEmail.get(normalizeEmail(q));
    if (id) {
      const e = idx.byId.get(id)!;
      const p = idx.properties.find((p) => p.id === e.property_id);
      if (p) hits.push(toHit(p, e, "email", q));
    }
  }

  // unit number
  if (/we\s?\d{2}/i.test(q)) {
    const id = idx.byUnitNumber.get(normalizeUnit(q));
    if (id) {
      const e = idx.byId.get(id)!;
      const p = idx.properties.find((p) => p.id === e.property_id);
      if (p) hits.push(toHit(p, e, "unit", q));
    }
  }

  // canonical / alias substring
  for (const e of idx.entities) {
    const all = [e.canonical_name, ...(e.aliases || [])]
      .filter(Boolean)
      .map((s) => s.toLowerCase());
    if (all.some((a) => a.includes(lower))) {
      const p = idx.properties.find((p) => p.id === e.property_id);
      if (p) hits.push(toHit(p, e, "alias", q));
    }
    if (hits.length > 30) break;
  }

  // dedupe
  const seen = new Set<string>();
  return hits.filter((h) => {
    const k = `${h.property_id}:${h.entity_id ?? ""}:${h.matched_field}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function toHit(
  p: { id: string; name: string },
  e: Entity,
  field: string,
  value: string,
): SearchHit {
  return {
    property_id: p.id,
    property_name: p.name,
    matched_field: field,
    matched_value: value,
    entity_id: e.id,
    entity_type: e.type,
    entity_name: e.canonical_name,
  };
}

export interface PropertyState {
  property_id: string;
  name: string;
  address: string;
  context_md: string;
  sources: unknown[];
  patches: unknown[];
  has_output: boolean;
}

export async function loadPropertyState(
  propertyId: string,
): Promise<PropertyState | null> {
  const idx = await loadIndex();
  const property = idx.properties.find((p) => p.id === propertyId);
  if (!property) return null;
  const dir = propertyOutDir(propertyId);
  const ctxPath = path.join(dir, "Context.md");
  const sourcesPath = path.join(dir, "sources.jsonl");
  const patchPath = path.join(dir, "patch_history.jsonl");
  const has = fs.existsSync(ctxPath);
  return {
    property_id: propertyId,
    name: property.name,
    address: property.address,
    context_md: has ? fs.readFileSync(ctxPath, "utf8") : "",
    sources: has && fs.existsSync(sourcesPath) ? readJsonl(sourcesPath) : [],
    patches: has && fs.existsSync(patchPath) ? readJsonl(patchPath) : [],
    has_output: has,
  };
}

function readJsonl(p: string): unknown[] {
  const lines = fs.readFileSync(p, "utf8").split(/\r?\n/).filter(Boolean);
  const out: unknown[] = [];
  for (const l of lines) {
    try {
      out.push(JSON.parse(l));
    } catch {}
  }
  return out;
}

export async function listProperties() {
  const idx = await loadIndex();
  return idx.properties.map((p) => ({
    id: p.id,
    name: p.name,
    address: p.address,
    has_output: fs.existsSync(path.join(propertyOutDir(p.id), "Context.md")),
  }));
}

export function metricsSnapshot() {
  return {
    out_root_exists: fs.existsSync(OUT_ROOT),
  };
}
