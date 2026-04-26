import path from "node:path";
import {
  loadIndex,
  normalizeEmail,
  normalizeIban,
  normalizeUnit,
  type MasterIndex,
} from "./index-store";
import type { ParsedFile } from "./parsers";
import type { SourceDocument } from "./types";

// Try to resolve a parsed source to (property_id, entity_refs).
// Order: explicit ID match > IBAN > email > unit number > content keywords > filename.
export interface Resolution {
  property_id: string | null;
  entity_refs: string[];
  candidates: string[]; // property ids
  reason: string;
}

const ENTITY_ID_RE = /\b(LIE|HAUS|EH|EIG|MIE|DL|INV|TX|EMAIL|LTR)-\d{2,5}\b/gi;

export async function resolveSource(
  filePath: string,
  parsed: ParsedFile,
): Promise<Resolution> {
  const idx = await loadIndex();
  const filename = path.basename(filePath);
  const text = parsed.text || "";
  const struct = parsed.structured;

  const entityRefs = new Set<string>();
  const candidates = new Set<string>();
  const reasons: string[] = [];

  // 1. Explicit IDs in filename or text
  for (const m of `${filename}\n${text}`.matchAll(ENTITY_ID_RE)) {
    const id = m[0].toUpperCase();
    if (idx.byId.has(id)) {
      entityRefs.add(id);
      const ent = idx.byId.get(id)!;
      if (ent.property_id) candidates.add(ent.property_id);
    }
  }
  if (candidates.size > 0) reasons.push("explicit-id");

  // 2. Structured fields (eml from/to, csv rows)
  if (struct && typeof struct === "object" && !Array.isArray(struct)) {
    const s = struct as Record<string, unknown>;
    for (const k of ["from", "to"]) {
      const v = s[k];
      if (typeof v === "string") {
        const emailMatch = v.match(/[\w.+-]+@[\w-]+\.[\w.-]+/g);
        for (const e of emailMatch || []) {
          const id = idx.byEmail.get(normalizeEmail(e));
          if (id) {
            entityRefs.add(id);
            const ent = idx.byId.get(id)!;
            if (ent.property_id) candidates.add(ent.property_id);
          }
        }
      }
    }
  }

  // 3. Email/IBAN matches in text
  for (const m of text.matchAll(/[\w.+-]+@[\w-]+\.[\w.-]+/g)) {
    const id = idx.byEmail.get(normalizeEmail(m[0]));
    if (id) {
      entityRefs.add(id);
      const ent = idx.byId.get(id)!;
      if (ent.property_id) candidates.add(ent.property_id);
    }
  }
  for (const m of text.matchAll(/\bDE\d{2}[\s\d]{16,30}\b/g)) {
    const id = idx.byIban.get(normalizeIban(m[0]));
    if (id) {
      entityRefs.add(id);
      const ent = idx.byId.get(id)!;
      if (ent.property_id) candidates.add(ent.property_id);
    }
  }

  // 4. Unit numbers like "WE 01"
  for (const m of text.matchAll(/\bWE\s?\d{2}\b/gi)) {
    const id = idx.byUnitNumber.get(normalizeUnit(m[0]));
    if (id) {
      entityRefs.add(id);
      const propId = idx.unitToProperty.get(id);
      if (propId) candidates.add(propId);
    }
  }

  // 5. Address keyword (single-property fallback)
  for (const p of idx.properties) {
    const addr = p.address.toLowerCase();
    const street = (p.metadata.strasse as string | undefined)?.toLowerCase();
    if (
      (street && text.toLowerCase().includes(street)) ||
      text.toLowerCase().includes(addr)
    ) {
      candidates.add(p.id);
      reasons.push("address-match");
    }
  }

  // 6. Verwalter domain fallback (e.g. emails routed via the management co.
  //    domain are still property-related even if no direct ID is found).
  if (candidates.size === 0) {
    if (struct && typeof struct === "object") {
      const allText = JSON.stringify(struct) + "\n" + text;
      for (const [domain, propId] of idx.emailDomainToProperty.entries()) {
        if (allText.toLowerCase().includes(domain)) {
          candidates.add(propId);
          reasons.push(`verwalter-domain:${domain}`);
          break;
        }
      }
    }
  }

  // 7. Single-property dataset fallback: if there's exactly one property and
  //    we found *any* known entity, default to it.
  if (candidates.size === 0 && idx.properties.length === 1) {
    candidates.add(idx.properties[0].id);
    reasons.push("single-property-fallback");
  }

  // Pick best property: prefer the one with the most matched entities.
  let resolved: string | null = null;
  if (candidates.size === 1) {
    resolved = [...candidates][0];
  } else if (candidates.size > 1) {
    const counts = new Map<string, number>();
    for (const eid of entityRefs) {
      const ent = idx.byId.get(eid);
      if (ent?.property_id) {
        counts.set(ent.property_id, (counts.get(ent.property_id) ?? 0) + 1);
      }
    }
    let best: string | null = null;
    let max = -1;
    for (const [pid, c] of counts) {
      if (c > max) {
        max = c;
        best = pid;
      }
    }
    resolved = best ?? [...candidates][0];
  }

  return {
    property_id: resolved,
    entity_refs: [...entityRefs],
    candidates: [...candidates],
    reason: reasons.join(", ") || "no-match",
  };
}

export function inferSourceType(filePath: string): SourceDocument["source_type"] {
  const lower = filePath.toLowerCase();
  if (lower.includes("/stammdaten/")) return "stammdaten";
  if (lower.includes("/emails/")) return "email";
  if (lower.includes("/rechnungen/")) return "invoice";
  if (lower.includes("/bank")) return "bank";
  if (lower.includes("/briefe/")) return "letter";
  if (lower.endsWith(".eml")) return "email";
  if (lower.endsWith(".pdf")) return "letter";
  return "structured";
}

export type IndexProbe = MasterIndex;
