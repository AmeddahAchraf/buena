import fs from "node:fs";
import path from "node:path";
import Papa from "papaparse";
import { DATASET_ROOT, SUBFOLDERS } from "./paths";
import type { Entity, Property } from "./types";

// In-memory index built from stammdaten/*. Single source of truth for resolution.
export interface MasterIndex {
  builtAt: string;
  properties: Property[];
  entities: Entity[];
  // lookup tables
  byId: Map<string, Entity>;
  byEmail: Map<string, string>; // email -> entity id
  byIban: Map<string, string>; // normalized iban -> entity id
  byUnitNumber: Map<string, string>; // "WE 01" -> EH-001
  byInvoiceNumber: Map<string, string>; // INV-2026-0195 -> INV id (if known)
  unitToProperty: Map<string, string>; // EH-* -> LIE-*
  ownerToProperty: Map<string, string>; // EIG-* -> LIE-*
  tenantToProperty: Map<string, string>; // MIE-* -> LIE-*
  vendorToProperty: Map<string, string>; // DL-* -> LIE-* (best-effort, fallback all)
  emailDomainToProperty: Map<string, string>; // huber-partner-verwaltung.de -> LIE-*
  knownVerwalterEmails: Set<string>;
}

let _cached: MasterIndex | null = null;

export async function loadIndex(force = false): Promise<MasterIndex> {
  if (_cached && !force) return _cached;
  _cached = buildIndex();
  return _cached;
}

function buildIndex(): MasterIndex {
  const stamm = path.join(DATASET_ROOT, SUBFOLDERS.stammdaten);
  const stammJson = JSON.parse(
    fs.readFileSync(path.join(stamm, "stammdaten.json"), "utf8"),
  );

  const properties: Property[] = [];
  const entities: Entity[] = [];

  // Property
  const lie = stammJson.liegenschaft;
  const propertyId = lie.id as string;
  properties.push({
    id: propertyId,
    name: lie.name,
    address: `${lie.strasse}, ${lie.plz} ${lie.ort}`,
    metadata: lie,
  });

  // Property as an entity
  entities.push({
    id: propertyId,
    type: "property",
    property_id: propertyId,
    canonical_name: lie.name,
    aliases: [lie.strasse, `${lie.strasse} ${lie.ort}`],
    metadata: lie,
  });

  // Verwalter as an entity (the management company)
  entities.push({
    id: "VW-001",
    type: "verwalter",
    property_id: propertyId,
    canonical_name: lie.verwalter,
    aliases: [lie.verwalter_email],
    metadata: {
      email: lie.verwalter_email,
      iban: lie.verwalter_iban,
    },
  });

  // Buildings
  for (const b of stammJson.gebaeude || []) {
    entities.push({
      id: b.id,
      type: "building",
      property_id: propertyId,
      canonical_name: `Haus ${b.hausnr}`,
      aliases: [`HAUS ${b.hausnr}`],
      metadata: b,
    });
  }

  // Units
  for (const u of stammJson.einheiten || []) {
    entities.push({
      id: u.id,
      type: "unit",
      property_id: propertyId,
      canonical_name: u.einheit_nr,
      aliases: [u.einheit_nr.replace(/\s+/g, ""), `Einheit ${u.einheit_nr}`],
      metadata: u,
    });
  }

  // Owners (eigentuemer.csv)
  const owners = readCsv(path.join(stamm, "eigentuemer.csv"));
  for (const r of owners) {
    const id = r.id as string;
    const name = r.firma
      ? r.firma
      : `${r.anrede ?? ""} ${r.vorname ?? ""} ${r.nachname ?? ""}`.trim();
    entities.push({
      id,
      type: "owner",
      property_id: propertyId,
      canonical_name: name,
      aliases: [
        r.email,
        r.firma,
        `${r.vorname} ${r.nachname}`.trim(),
        `${r.nachname}`,
      ].filter(Boolean) as string[],
      metadata: r,
    });
  }

  // Tenants (mieter.csv)
  const tenants = readCsv(path.join(stamm, "mieter.csv"));
  for (const r of tenants) {
    entities.push({
      id: r.id as string,
      type: "tenant",
      property_id: propertyId,
      canonical_name: `${r.anrede ?? ""} ${r.vorname ?? ""} ${r.nachname ?? ""}`.trim(),
      aliases: [
        r.email,
        `${r.vorname} ${r.nachname}`.trim(),
        `${r.nachname}`,
      ].filter(Boolean) as string[],
      metadata: r,
    });
  }

  // Vendors (dienstleister.csv)
  const vendors = readCsv(path.join(stamm, "dienstleister.csv"));
  for (const r of vendors) {
    entities.push({
      id: r.id as string,
      type: "vendor",
      property_id: propertyId,
      canonical_name: r.firma as string,
      aliases: [r.email, r.ansprechpartner].filter(Boolean) as string[],
      metadata: r,
    });
  }

  // Build lookup tables
  const byId = new Map<string, Entity>();
  const byEmail = new Map<string, string>();
  const byIban = new Map<string, string>();
  const byUnitNumber = new Map<string, string>();
  const unitToProperty = new Map<string, string>();
  const ownerToProperty = new Map<string, string>();
  const tenantToProperty = new Map<string, string>();
  const vendorToProperty = new Map<string, string>();
  const emailDomainToProperty = new Map<string, string>();
  const knownVerwalterEmails = new Set<string>();

  for (const e of entities) {
    byId.set(e.id, e);
    const meta = e.metadata as Record<string, unknown>;
    const email =
      (meta.email as string | undefined) || extractAlias(e.aliases, "@");
    if (email) byEmail.set(normalizeEmail(email), e.id);
    const iban = meta.iban as string | undefined;
    if (iban) byIban.set(normalizeIban(iban), e.id);

    if (e.type === "unit") {
      byUnitNumber.set(normalizeUnit(e.canonical_name), e.id);
      if (e.property_id) unitToProperty.set(e.id, e.property_id);
    }
    if (e.type === "owner" && e.property_id)
      ownerToProperty.set(e.id, e.property_id);
    if (e.type === "tenant" && e.property_id)
      tenantToProperty.set(e.id, e.property_id);
    if (e.type === "vendor" && e.property_id)
      vendorToProperty.set(e.id, e.property_id);

    if (e.type === "verwalter") {
      const ve = (meta.email as string | undefined) || "";
      if (ve) {
        knownVerwalterEmails.add(normalizeEmail(ve));
        const dom = ve.split("@")[1]?.toLowerCase();
        if (dom && e.property_id) emailDomainToProperty.set(dom, e.property_id);
      }
    }
  }

  return {
    builtAt: new Date().toISOString(),
    properties,
    entities,
    byId,
    byEmail,
    byIban,
    byUnitNumber,
    byInvoiceNumber: new Map(),
    unitToProperty,
    ownerToProperty,
    tenantToProperty,
    vendorToProperty,
    emailDomainToProperty,
    knownVerwalterEmails,
  };
}

function readCsv(p: string): Record<string, string>[] {
  const raw = fs.readFileSync(p, "utf8");
  const out = Papa.parse<Record<string, string>>(raw, {
    header: true,
    skipEmptyLines: true,
  });
  return out.data;
}

function extractAlias(aliases: string[], needle: string): string | undefined {
  return aliases.find((a) => typeof a === "string" && a.includes(needle));
}

export function normalizeEmail(s: string): string {
  return s.trim().toLowerCase();
}

export function normalizeIban(s: string): string {
  return s.replace(/\s+/g, "").toUpperCase();
}

export function normalizeUnit(s: string): string {
  return s.replace(/\s+/g, "").toUpperCase();
}
