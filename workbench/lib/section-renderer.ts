// Deterministically renders the *base* sections of a Context.md from the
// master index. Everything here is reproducible from stammdaten alone — no
// AI call, no flake. The challenge wants "dense, structured, traced" — so
// every renderer here optimises for facts-per-line over prose.

import type { Property } from "./types";
import type { MasterIndex } from "./index-store";

// ---------- helpers ----------

const fmtEUR = (n: number, frac = 0) =>
  new Intl.NumberFormat("de-DE", {
    style: "currency",
    currency: "EUR",
    minimumFractionDigits: frac,
    maximumFractionDigits: frac,
  }).format(n);

const fmtNum = (n: number, frac = 0) =>
  new Intl.NumberFormat("de-DE", {
    minimumFractionDigits: frac,
    maximumFractionDigits: frac,
  }).format(n);

const fmtPct = (n: number) =>
  `${new Intl.NumberFormat("de-DE", { maximumFractionDigits: 1 }).format(
    n * 100,
  )}%`;

function num(v: unknown): number {
  const n = typeof v === "string" ? parseFloat(v) : (v as number);
  return Number.isFinite(n) ? n : 0;
}

function isActiveLease(metadata: Record<string, unknown>): boolean {
  const end = (metadata.mietende as string | undefined) ?? "";
  return !end.trim();
}

interface PropertyVitals {
  unitsTotal: number;
  unitsWohnung: number;
  unitsGewerbe: number;
  unitsTiefgarage: number;
  totalQm: number;
  buildings: number;
  activeLeases: number;
  selbstnutzer: number;
  occupied: number; // active leases + Selbstnutzer
  vacant: number;
  occupancy: number; // 0..1
  monthlyKaltmiete: number;
  monthlyNk: number;
  yearlyKaltmiete: number;
  totalKaution: number;
  monthlyVendorContracts: number;
  beiratNames: string[];
  meaSum: number; // should be 1000 in WEG
}

/** Pure derivation from the index. The same numbers a property manager
 *  would compute by hand — useful for the AI agent to read at a glance. */
export function computeVitals(
  idx: MasterIndex,
  propertyId: string,
): PropertyVitals {
  const ents = idx.entities.filter((e) => e.property_id === propertyId);
  const buildings = ents.filter((e) => e.type === "building");
  const units = ents.filter((e) => e.type === "unit");
  const tenants = ents.filter((e) => e.type === "tenant");
  const owners = ents.filter((e) => e.type === "owner");
  const vendors = ents.filter((e) => e.type === "vendor");

  const activeTenants = tenants.filter((t) => isActiveLease(t.metadata));
  const monthlyKaltmiete = activeTenants.reduce(
    (s, t) => s + num(t.metadata.kaltmiete),
    0,
  );
  const monthlyNk = activeTenants.reduce(
    (s, t) => s + num(t.metadata.nk_vorauszahlung),
    0,
  );
  const totalKaution = activeTenants.reduce(
    (s, t) => s + num(t.metadata.kaution),
    0,
  );
  const monthlyVendorContracts = vendors.reduce(
    (s, v) => s + num(v.metadata.vertrag_monatlich),
    0,
  );

  // Selbstnutzer: owners marked self-occupying. Each owner can hold multiple
  // units; we count occupied units once even if shared.
  const selbstnutzerUnits = new Set<string>();
  for (const o of owners) {
    const flag = String(o.metadata.selbstnutzer ?? "").toLowerCase();
    const isSelf = flag === "true" || flag === "1" || flag === "ja";
    if (!isSelf) continue;
    const ids = String(o.metadata.einheit_ids ?? "")
      .split(/[;,]/)
      .map((s) => s.trim())
      .filter(Boolean);
    for (const id of ids) selbstnutzerUnits.add(id);
  }
  const tenantedUnits = new Set(
    activeTenants
      .map((t) => String(t.metadata.einheit_id ?? "").trim())
      .filter(Boolean),
  );
  const occupied = new Set([...tenantedUnits, ...selbstnutzerUnits]).size;
  const vacant = Math.max(0, units.length - occupied);

  const totalQm = units.reduce((s, u) => s + num(u.metadata.wohnflaeche_qm), 0);
  const meaSum = units.reduce(
    (s, u) => s + num(u.metadata.miteigentumsanteil),
    0,
  );

  const beirat = owners
    .filter(
      (o) =>
        String(o.metadata.beirat ?? "").toLowerCase() === "true" ||
        String(o.metadata.beirat ?? "") === "1",
    )
    .map((o) => o.canonical_name);

  return {
    unitsTotal: units.length,
    unitsWohnung: units.filter((u) => u.metadata.typ === "Wohnung").length,
    unitsGewerbe: units.filter((u) => u.metadata.typ === "Gewerbe").length,
    unitsTiefgarage: units.filter((u) => u.metadata.typ === "Tiefgarage")
      .length,
    totalQm,
    buildings: buildings.length,
    activeLeases: activeTenants.length,
    selbstnutzer: selbstnutzerUnits.size,
    occupied,
    vacant,
    occupancy: units.length ? occupied / units.length : 0,
    monthlyKaltmiete,
    monthlyNk,
    yearlyKaltmiete: monthlyKaltmiete * 12,
    totalKaution,
    monthlyVendorContracts,
    beiratNames: beirat,
    meaSum,
  };
}

// ---------- section renderers ----------

export function renderIdentity(
  property: Property,
  idx?: MasterIndex,
): string {
  const m = property.metadata as Record<string, string | number>;
  const v = idx ? computeVitals(idx, property.id) : null;

  const lines: string[] = [];

  // Hero "How it stands" block — the snapshot every dashboard wants. Pure
  // markdown table so it renders nicely both in the UI and in plain GitHub.
  if (v) {
    lines.push(`> **${property.name} — how it stands.**`);
    lines.push(``);
    lines.push(
      `| Built | Units | Total qm | Rent / month | Occupied | Vacancy |`,
    );
    lines.push(`|---|---|---|---|---|---|`);
    lines.push(
      `| **${m.baujahr}**${m.sanierung ? ` _(reno ${m.sanierung})_` : ""} | **${v.unitsTotal}** | **${fmtNum(v.totalQm, 1)} m²** | **${fmtEUR(v.monthlyKaltmiete)}** _(${fmtEUR(v.yearlyKaltmiete)}/yr)_ | **${v.occupied}/${v.unitsTotal}** _(${v.vacant} vacant)_ | ${fmtPct(1 - v.occupancy)} |`,
    );
    lines.push(``);
  }

  lines.push(`- **Property ID:** \`${property.id}\``);
  lines.push(`- **Name:** ${property.name}`);
  lines.push(`- **Address:** ${property.address}`);
  lines.push(`- **Verwalter:** ${m.verwalter} (${m.verwalter_email})`);
  lines.push(
    `- **WEG Bankkonto IBAN:** \`${m.weg_bankkonto_iban}\` (${m.weg_bankkonto_bank})`,
  );
  lines.push(`- **Rücklage IBAN:** \`${m.ruecklage_iban}\``);
  lines.push(
    `- **Baujahr:** ${m.baujahr}${m.sanierung ? ` (Sanierung ${m.sanierung})` : ""}`,
  );
  if (v) {
    lines.push(
      `- **Building mix:** ${v.unitsWohnung} Wohnungen · ${v.unitsGewerbe} Gewerbe · ${v.unitsTiefgarage} Tiefgaragen across ${v.buildings} Häuser`,
    );
    lines.push(
      `- **MEA total:** ${fmtNum(v.meaSum)} ${v.meaSum === 1000 ? "✓" : "⚑ expected 1000"}`,
    );
  }
  return lines.join("\n");
}

export function renderUnits(idx: MasterIndex, propertyId: string): string {
  const buildings = idx.entities.filter(
    (e) => e.type === "building" && e.property_id === propertyId,
  );
  const units = idx.entities.filter(
    (e) => e.type === "unit" && e.property_id === propertyId,
  );
  const tenants = idx.entities.filter(
    (e) => e.type === "tenant" && e.property_id === propertyId,
  );
  const owners = idx.entities.filter(
    (e) => e.type === "owner" && e.property_id === propertyId,
  );

  // unit_id -> active tenant entity (only most-recent active lease per unit)
  const activeTenantByUnit = new Map<string, (typeof tenants)[number]>();
  for (const t of tenants) {
    if (!isActiveLease(t.metadata)) continue;
    const u = String(t.metadata.einheit_id ?? "").trim();
    if (u) activeTenantByUnit.set(u, t);
  }
  // unit_id -> owner entity (first match wins)
  const ownerByUnit = new Map<string, (typeof owners)[number]>();
  const selbstnutzerUnits = new Set<string>();
  for (const o of owners) {
    const ids = String(o.metadata.einheit_ids ?? "")
      .split(/[;,]/)
      .map((s) => s.trim())
      .filter(Boolean);
    const isSelf =
      ["true", "1", "ja"].indexOf(
        String(o.metadata.selbstnutzer ?? "").toLowerCase(),
      ) >= 0;
    for (const id of ids) {
      if (!ownerByUnit.has(id)) ownerByUnit.set(id, o);
      if (isSelf) selbstnutzerUnits.add(id);
    }
  }

  const v = computeVitals(idx, propertyId);
  const lines: string[] = [];
  lines.push(
    `**${v.unitsTotal}** units · **${v.unitsWohnung}** Wohnungen · **${v.unitsGewerbe}** Gewerbe · **${v.unitsTiefgarage}** Tiefgaragen across **${v.buildings}** Häuser. **${v.occupied}** belegt (${v.activeLeases} vermietet, ${v.selbstnutzer} Selbstnutzer) · **${v.vacant}** leer · **${fmtNum(v.totalQm, 1)} m²** total · **${fmtEUR(v.monthlyKaltmiete)}/Monat** Kaltmiete.`,
  );
  lines.push("");
  for (const b of buildings) {
    const buildingUnits = units.filter((u) => u.metadata.haus_id === b.id);
    if (buildingUnits.length === 0) continue;
    const bQm = buildingUnits.reduce(
      (s, u) => s + num(u.metadata.wohnflaeche_qm),
      0,
    );
    const bRent = buildingUnits.reduce((s, u) => {
      const t = activeTenantByUnit.get(u.id);
      return s + (t ? num(t.metadata.kaltmiete) : 0);
    }, 0);
    lines.push(
      `### ${b.canonical_name} — ${buildingUnits.length} Einheiten · ${fmtNum(bQm, 1)} m² · ${fmtEUR(bRent)}/Monat`,
    );
    lines.push("");
    lines.push(
      `| Unit | Lage | Typ | qm | Zi. | MEA | Eigentümer | Mieter | Kaltmiete | NK | Kaution | Mietbeginn |`,
    );
    lines.push(
      `|---|---|---|---:|---:|---:|---|---|---:|---:|---:|---|`,
    );
    for (const u of buildingUnits) {
      const t = activeTenantByUnit.get(u.id);
      const o = ownerByUnit.get(u.id);
      const isSelf = selbstnutzerUnits.has(u.id);
      const ownerCell = o
        ? `\`${o.id}\` ${o.canonical_name}${isSelf ? " · 🏠 Selbstnutzer" : ""}`
        : "—";
      const tenantCell = t
        ? `\`${t.id}\` ${t.canonical_name}`
        : isSelf
          ? "_(Selbstnutzer)_"
          : "_leer_";
      const kalt = t ? fmtEUR(num(t.metadata.kaltmiete)) : "—";
      const nk = t ? fmtEUR(num(t.metadata.nk_vorauszahlung)) : "—";
      const kaution = t ? fmtEUR(num(t.metadata.kaution)) : "—";
      const start = t ? String(t.metadata.mietbeginn ?? "") : "";
      const mea = u.metadata.miteigentumsanteil
        ? fmtNum(num(u.metadata.miteigentumsanteil))
        : "";
      const qm = u.metadata.wohnflaeche_qm
        ? fmtNum(num(u.metadata.wohnflaeche_qm), 1)
        : "";
      const zi = (u.metadata.zimmer as string | number | undefined) ?? "";
      lines.push(
        `| \`${u.id}\` ${u.canonical_name} | ${u.metadata.lage ?? ""} | ${u.metadata.typ ?? ""} | ${qm} | ${zi} | ${mea} | ${ownerCell} | ${tenantCell} | ${kalt} | ${nk} | ${kaution} | ${start} |`,
      );
    }
    lines.push("");
  }
  return lines.join("\n").trim();
}

export function renderVendors(idx: MasterIndex, propertyId: string): string {
  const vendors = idx.entities.filter(
    (e) => e.type === "vendor" && e.property_id === propertyId,
  );
  if (vendors.length === 0) return "_No vendors on file._";
  const monthly = vendors.reduce(
    (s, v) => s + num(v.metadata.vertrag_monatlich),
    0,
  );
  const lines: string[] = [];
  lines.push(
    `**${vendors.length}** Dienstleister · **${fmtEUR(monthly)}/Monat** in laufenden Verträgen (${fmtEUR(monthly * 12)}/Jahr).`,
  );
  lines.push("");
  lines.push(
    `| Vendor | Branche | Kontakt | E-Mail | Telefon | Vertrag/Monat | Stundensatz |`,
  );
  lines.push(`|---|---|---|---|---|---:|---:|`);
  for (const v of vendors) {
    const vm = num(v.metadata.vertrag_monatlich);
    const sh = num(v.metadata.stundensatz);
    lines.push(
      `| \`${v.id}\` ${v.canonical_name} | ${v.metadata.branche ?? ""} | ${v.metadata.ansprechpartner ?? ""} | ${v.metadata.email ?? ""} | ${v.metadata.telefon ?? ""} | ${vm ? fmtEUR(vm) : "—"} | ${sh ? fmtEUR(sh) : "—"} |`,
    );
  }
  return lines.join("\n");
}

export function renderGovernance(
  property: Property,
  idx?: MasterIndex,
): string {
  const m = property.metadata as Record<string, unknown>;
  const lines: string[] = [];
  lines.push(`- **Verwaltungsfirma:** ${m.verwalter}`);
  lines.push(
    `- **Verwalter Anschrift:** ${m.verwalter_strasse}, ${m.verwalter_plz} ${m.verwalter_ort}`,
  );
  lines.push(
    `- **Verwalter Kontakt:** ${m.verwalter_telefon} · ${m.verwalter_email}`,
  );
  lines.push(`- **Verwalter Steuer-Nr.:** ${m.verwalter_steuernummer}`);

  if (idx) {
    const owners = idx.entities.filter(
      (e) => e.type === "owner" && e.property_id === property.id,
    );
    const beirat = owners.filter(
      (o) =>
        String(o.metadata.beirat ?? "").toLowerCase() === "true" ||
        String(o.metadata.beirat ?? "") === "1",
    );
    const selbstnutzerCount = owners.filter(
      (o) =>
        ["true", "1", "ja"].indexOf(
          String(o.metadata.selbstnutzer ?? "").toLowerCase(),
        ) >= 0,
    ).length;
    lines.push(
      `- **Eigentümer total:** ${owners.length} (${selbstnutzerCount} Selbstnutzer · ${owners.length - selbstnutzerCount} Vermieter)`,
    );
    if (beirat.length) {
      lines.push(`- **Beirat (${beirat.length}):**`);
      for (const o of beirat) {
        const role = o.metadata.beirat_rolle
          ? ` _(${o.metadata.beirat_rolle})_`
          : "";
        lines.push(
          `  - \`${o.id}\` **${o.canonical_name}**${role} · ${o.metadata.email ?? ""} · ${o.metadata.telefon ?? ""}`,
        );
      }
    } else {
      lines.push(`- **Beirat:** _none on file_`);
    }
  }
  lines.push(`_(open governance items get appended here as they appear)_`);
  return lines.join("\n");
}

export function renderFinanceBaseline(
  property: Property,
  idx?: MasterIndex,
): string {
  const m = property.metadata as Record<string, unknown>;
  const lines: string[] = [];
  lines.push(
    `- **Operating account:** \`${m.weg_bankkonto_iban}\` (${m.weg_bankkonto_bank})`,
  );
  lines.push(`- **Reserve account:** \`${m.ruecklage_iban}\``);
  if (idx) {
    const v = computeVitals(idx, property.id);
    lines.push(``);
    lines.push(
      `| Posten | Pro Monat | Pro Jahr |`,
    );
    lines.push(`|---|---:|---:|`);
    lines.push(
      `| Kaltmiete (${v.activeLeases} aktive Mietverhältnisse) | **${fmtEUR(v.monthlyKaltmiete)}** | **${fmtEUR(v.yearlyKaltmiete)}** |`,
    );
    lines.push(
      `| Nebenkosten-Vorauszahlung | ${fmtEUR(v.monthlyNk)} | ${fmtEUR(v.monthlyNk * 12)} |`,
    );
    lines.push(
      `| Brutto (Kalt + NK) | ${fmtEUR(v.monthlyKaltmiete + v.monthlyNk)} | ${fmtEUR((v.monthlyKaltmiete + v.monthlyNk) * 12)} |`,
    );
    lines.push(
      `| Vendor-Verträge (${v.monthlyVendorContracts ? "laufend" : "—"}) | ${fmtEUR(v.monthlyVendorContracts)} | ${fmtEUR(v.monthlyVendorContracts * 12)} |`,
    );
    lines.push(``);
    lines.push(
      `- **Kautionen total (verwahrt):** ${fmtEUR(v.totalKaution)} über ${v.activeLeases} Mietverhältnisse.`,
    );
    if (v.unitsTotal) {
      const rentPerQm = v.totalQm
        ? v.monthlyKaltmiete / v.totalQm
        : 0;
      lines.push(
        `- **Durchschnittsmiete:** ${rentPerQm ? fmtEUR(rentPerQm, 2) + "/m²" : "—"} · ${v.activeLeases ? fmtEUR(v.monthlyKaltmiete / v.activeLeases) + "/Einheit" : "—"}.`,
      );
    }
  }
  lines.push(`_(invoices and bank entries surface here as they're processed)_`);
  return lines.join("\n");
}
