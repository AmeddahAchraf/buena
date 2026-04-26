import fs from "node:fs";
import path from "node:path";
import Papa from "papaparse";
import { XMLParser } from "fast-xml-parser";

export interface ParsedFile {
  text: string;
  structured?: unknown;
  meta: Record<string, unknown>;
}

const xml = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
});

export async function parseFile(absPath: string): Promise<ParsedFile> {
  const ext = path.extname(absPath).toLowerCase();
  switch (ext) {
    case ".json":
      return parseJson(absPath);
    case ".csv":
    case ".tsv":
      return parseCsv(absPath);
    case ".xml":
      return parseXml(absPath);
    case ".eml":
      return parseEml(absPath);
    case ".pdf":
      return parsePdf(absPath);
    case ".txt":
    case ".md":
      return parseText(absPath);
    default:
      try {
        return parseText(absPath);
      } catch {
        return { text: "", meta: { error: "unparseable" } };
      }
  }
}

function parseJson(p: string): ParsedFile {
  const raw = fs.readFileSync(p, "utf8");
  let structured: unknown = null;
  try {
    structured = JSON.parse(raw);
  } catch {
    // ignore
  }
  return { text: raw, structured, meta: {} };
}

function parseCsv(p: string): ParsedFile {
  const raw = fs.readFileSync(p, "utf8");
  // German bank exports use ; as separator. Auto-detect via header.
  const firstLine = raw.split(/\r?\n/, 1)[0] || "";
  const delimiter = firstLine.includes(";") && !firstLine.includes(",")
    ? ";"
    : firstLine.split(";").length > firstLine.split(",").length
      ? ";"
      : ",";
  const result = Papa.parse(raw, {
    header: true,
    skipEmptyLines: true,
    delimiter,
  });
  return {
    text: raw,
    structured: result.data,
    meta: {
      rows: (result.data as unknown[]).length,
      delimiter,
      fields: result.meta.fields ?? [],
    },
  };
}

function parseXml(p: string): ParsedFile {
  const raw = fs.readFileSync(p, "utf8");
  let structured: unknown = null;
  try {
    structured = xml.parse(raw);
  } catch {}
  return { text: raw, structured, meta: {} };
}

async function parseEml(p: string): Promise<ParsedFile> {
  const { simpleParser } = await import("mailparser");
  const raw = fs.readFileSync(p);
  const parsed = await simpleParser(raw);
  const text = parsed.text || (parsed.html ? stripHtml(parsed.html) : "");
  return {
    text,
    structured: {
      from: parsed.from?.text ?? null,
      to: parsed.to
        ? Array.isArray(parsed.to)
          ? parsed.to.map((t: { text: string }) => t.text).join(", ")
          : parsed.to.text
        : null,
      subject: parsed.subject ?? null,
      date: parsed.date?.toISOString() ?? null,
      messageId: parsed.messageId ?? null,
      inReplyTo: parsed.inReplyTo ?? null,
      references: parsed.references ?? null,
    },
    meta: {
      headers_count: parsed.headerLines?.length ?? 0,
    },
  };
}

function stripHtml(s: string): string {
  return s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

async function parsePdf(p: string): Promise<ParsedFile> {
  // pdf-parse references a hard-coded test path on import; we work around it
  // by importing the inner module directly.
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore - pdf-parse has no proper subpath types
  const pdfParse = (await import("pdf-parse/lib/pdf-parse.js")).default as (
    b: Buffer,
  ) => Promise<{ text: string; numpages: number; info: unknown }>;
  const buf = fs.readFileSync(p);
  try {
    const out = await pdfParse(buf);
    return {
      text: out.text || "",
      meta: { pages: out.numpages, info: out.info },
    };
  } catch (err) {
    return {
      text: "",
      meta: { error: (err as Error).message, pdf_unreadable: true },
    };
  }
}

function parseText(p: string): ParsedFile {
  const raw = fs.readFileSync(p, "utf8");
  return { text: raw, meta: {} };
}
