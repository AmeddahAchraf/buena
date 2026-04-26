"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { I, SourceIcon, DecisionIcon } from "./icons";
import { startRecording, type Recorder } from "@/lib/voice-recorder";

type PendingItem = {
  source: {
    id: string;
    rel_path: string;
    source_type: string;
    resolved_property_id: string | null;
    entity_refs: string[];
    property_candidates: string[];
    meta?: Record<string, unknown>;
  };
  decision: {
    source_id: string;
    property_id: string | null;
    entity_ids: string[];
    decision: "durable_fact" | "operational_memory" | "temporary_note" | "ignore";
    target_sections: string[];
    summary: string;
    confidence: number;
    needs_review: boolean;
    review_reason: string | null;
    citations: string[];
    reasoning: string;
    source: "rule" | "ai" | "hybrid";
    proposed_facts?: Record<string, unknown>;
    facts?: Array<{
      key: string;
      label: string;
      value: string;
      qualifier?: string;
      section: string;
    }>;
    fact_key?: string | null;
    relevance?: number;
    collapsed_followups?: number;
  };
  diff_preview: string;
  before: string;
  after: string;
  parsedTextPreview: string;
  alreadyApplied: boolean;
};

type Property = {
  id: string;
  name: string;
  address: string;
  has_output: boolean;
};

type PropertyState = {
  property_id: string;
  name: string;
  address: string;
  context_md: string;
  sources: Array<Record<string, unknown>>;
  patches: Array<Record<string, unknown>>;
  has_output: boolean;
};

type Metrics = {
  total_files: number;
  avg_incremental_ms: number | null;
  last_incremental_ms: number | null;
  last_full_build_at: string | null;
  last_incremental_at: string | null;
  pending_count: number;
  pending_review_count: number;
  unresolved_count: number;
};

type AIStats = {
  enabled: boolean;
  model: string;
  calls: number;
  success: number;
  failed: number;
  retries: number;
  avg_ms: number | null;
  last_ms: number | null;
  last_error: string | null;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
};

type DayInfo = {
  day: string;
  total_files: number;
  files_by_type: Record<string, number>;
  content_date?: string;
  difficulty?: string;
  ingested_count: number;
  status: "fresh" | "partial" | "ingested";
};

type Tab = "context" | "sources";

export default function Workbench() {
  const [properties, setProperties] = useState<Property[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [propState, setPropState] = useState<PropertyState | null>(null);
  const [pending, setPending] = useState<PendingItem[]>([]);
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [aiStats, setAiStats] = useState<AIStats | null>(null);
  const [days, setDays] = useState<DayInfo[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("context");
  const [rawMd, setRawMd] = useState(false);
  const [drawer, setDrawer] = useState<PendingItem | null>(null);
  const [pendingFilter, setPendingFilter] = useState<
    "all" | "review" | "durable" | "operational" | "temporary" | "ignore"
  >("all");
  const [query, setQuery] = useState("");
  const [searchHits, setSearchHits] = useState<
    {
      property_id: string;
      entity_id?: string;
      entity_type?: string;
      entity_name?: string;
      matched_field: string;
    }[]
  >([]);
  const [voiceState, setVoiceState] = useState<"idle" | "recording" | "transcribing">("idle");
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const recorderRef = useRef<Recorder | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [autoApply, setAutoApply] = useState(false);
  const [dayMenu, setDayMenu] = useState(false);
  const [aiPulse, setAiPulse] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [pendingCollapsed, setPendingCollapsed] = useState(false);
  type LogEntry = { ts: number; msg: string; kind: "info" | "ai" | "ok" | "warn" | "step" };
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [loadingStep, setLoadingStep] = useState(0);
  const [loadingTitle, setLoadingTitle] = useState<string | null>(null);

  const log = useCallback((msg: string, kind: LogEntry["kind"] = "info") => {
    setLogs((prev) => [{ ts: Date.now(), msg, kind }, ...prev].slice(0, 80));
  }, []);

  const toggleVoiceSearch = useCallback(async () => {
    setVoiceError(null);
    if (voiceState === "recording") {
      const rec = recorderRef.current;
      if (!rec) {
        setVoiceState("idle");
        return;
      }
      setVoiceState("transcribing");
      try {
        const wav = await rec.stop();
        recorderRef.current = null;
        const res = await fetch("/api/stt", {
          method: "POST",
          headers: { "Content-Type": "audio/wav" },
          body: wav,
        });
        const json = (await res.json()) as { text?: string; error?: string };
        if (!res.ok || json.error) throw new Error(json.error || `STT failed (${res.status})`);
        const text = (json.text || "").trim();
        if (text) {
          setQuery(text);
          log(`Voice search: "${text}"`, "ai");
        } else {
          setVoiceError("No speech detected.");
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setVoiceError(message);
        log(`Voice search failed: ${message}`, "warn");
      } finally {
        setVoiceState("idle");
      }
      return;
    }

    if (voiceState === "transcribing") return;

    try {
      const rec = await startRecording();
      recorderRef.current = rec;
      setVoiceState("recording");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setVoiceError(message);
    }
  }, [voiceState, log]);

  const refreshProperties = useCallback(async () => {
    const r = await fetch("/api/properties").then((r) => r.json());
    setProperties(r.properties || []);
    setActiveId((cur) => cur ?? r.properties?.[0]?.id ?? null);
  }, []);

  const refreshProperty = useCallback(async (id: string) => {
    const r = await fetch(`/api/properties/${id}`).then((r) => r.json());
    if (!r.error) setPropState(r);
    else setPropState(null);
  }, []);

  const refreshPending = useCallback(async () => {
    const r = await fetch("/api/pending").then((r) => r.json());
    setPending(r.items || []);
    setMetrics(r.metrics);
    setAiStats(r.ai);
  }, []);

  const refreshDays = useCallback(async () => {
    try {
      const r = await fetch("/api/incremental-days").then((r) => r.json());
      setDays(r.days || []);
    } catch {}
  }, []);

  useEffect(() => {
    refreshProperties();
    refreshPending();
    refreshDays();
  }, [refreshProperties, refreshPending, refreshDays]);

  useEffect(() => {
    if (activeId) refreshProperty(activeId);
  }, [activeId, refreshProperty]);

  useEffect(() => {
    if (!query.trim()) {
      setSearchHits([]);
      return;
    }
    const id = setTimeout(async () => {
      const r = await fetch(`/api/search?q=${encodeURIComponent(query)}`).then((r) => r.json());
      setSearchHits(r.hits || []);
    }, 180);
    return () => clearTimeout(id);
  }, [query]);

  async function buildAll() {
    setBusy("Building all properties");
    setLoadingTitle("Full rebuild");
    log("Full rebuild started — wiping incremental state", "step");
    try {
      const r = await fetch("/api/build-all", { method: "POST" }).then((r) => r.json());
      log(`Indexed ${r.total_files ?? "?"} base files across ${r.properties?.length ?? 0} properties`, "ok");
      if (r.collapsed_threads) log(`Thread-collapsed ${r.collapsed_threads} email followup(s) into primary messages`, "info");
      if (r.filtered_noise) log(`Relevance gate dropped ${r.filtered_noise} noise file(s) without AI cost`, "info");
      if (r.ai_classified) log(`AI classified ${r.ai_classified} documents · ${r.ai_applied} written into Context.md · ${r.ai_ignored} judged as noise`, "ai");
      if (r.ai_needs_review) log(`Flagged ${r.ai_needs_review} fact(s) as needs-review (sensitive content)`, "warn");
      flash(
        `${r.ai_applied ?? 0} facts written · ${r.ai_classified ?? 0} ai · ${r.collapsed_threads ?? 0} threaded · ${r.ms}ms`,
      );
      await refreshProperties();
      if (activeId) await refreshProperty(activeId);
      await refreshPending();
      await refreshDays();
      log("UI ready · pick an incremental day to ingest", "info");
    } catch (e) {
      log(`Build failed: ${(e as Error).message}`, "warn");
    } finally {
      setBusy(null);
      setLoadingTitle(null);
    }
  }

  async function ingestDay(day: string | "all") {
    const label = day === "all" ? "all days" : day;
    setBusy(day === "all" ? "Ingesting all days" : `Ingesting ${day}`);
    setLoadingTitle(day === "all" ? "Ingesting all incremental days" : `Ingesting ${day}`);
    setDayMenu(false);
    setAiPulse(true);
    log(`Ingest started · ${label}`, "step");
    try {
      const body =
        day === "all"
          ? { autoApply, onlyNew: true, concurrency: 8 }
          : { autoApply, onlyNew: true, day, concurrency: 8 };
      const r = await fetch("/api/ingest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }).then((r) => r.json());
      log(`Scanned ${r.scanned ?? r.processed ?? 0} files`, "info");
      if (r.collapsed_threads) log(`Thread-collapsed ${r.collapsed_threads} email followup(s) into primary messages`, "info");
      if (r.filtered_noise) log(`Relevance gate filtered ${r.filtered_noise} file(s) as noise (no AI call)`, "info");
      if (r.ai_used) log(`Classifier called AI ${r.ai_used} time(s)`, "ai");
      if (r.superseded) log(`Detected ${r.superseded} fact-key conflict(s) — older facts will be superseded`, "warn");
      if (r.skipped) log(`Skipped ${r.skipped} unchanged file(s)`, "info");
      log(`Generated ${r.processed ?? 0} pending update(s) in ${r.ms ?? "?"}ms`, "ok");
      await refreshPending();
      await refreshDays();
      if (activeId) await refreshProperty(activeId);
      flash(
        `${r.processed} ingested · ${r.ai_used} ai · ${r.filtered_noise ?? 0} noise · ${r.collapsed_threads ?? 0} threaded · ${r.ms}ms`,
      );
    } catch (e) {
      log(`Ingest failed: ${(e as Error).message}`, "warn");
    } finally {
      setBusy(null);
      setLoadingTitle(null);
      setTimeout(() => setAiPulse(false), 1500);
    }
  }

  async function actOnPending(id: string, action: "apply" | "reject" | "temporary") {
    setBusy(`${action} ${id.slice(0, 12)}…`);
    log(`${action} ${id.slice(0, 12)}…`, action === "apply" ? "ok" : action === "reject" ? "warn" : "info");
    try {
      await fetch(`/api/pending/${id}?action=${action}`, { method: "POST" });
      await refreshPending();
      if (activeId) await refreshProperty(activeId);
      setDrawer(null);
      flash(`${action} ✓`);
    } finally {
      setBusy(null);
    }
  }

  // Animated pipeline step driver while ingesting/building
  useEffect(() => {
    if (!loadingTitle) {
      setLoadingStep(0);
      return;
    }
    setLoadingStep(0);
    const id = setInterval(() => {
      setLoadingStep((s) => (s + 1) % 5);
    }, 850);
    return () => clearInterval(id);
  }, [loadingTitle]);

  function flash(msg: string) {
    setToast(msg);
    setTimeout(() => setToast(null), 2200);
  }

  const unresolvedFiles = useMemo(
    () => pending.filter((p) => !p.decision.property_id),
    [pending],
  );
  const matchedFiles = useMemo(
    () => pending.filter((p) => p.decision.property_id === activeId),
    [pending, activeId],
  );

  const nextFreshDay = useMemo(
    () => days.find((d) => d.status === "fresh") ?? days.find((d) => d.status === "partial"),
    [days],
  );

  return (
    <div className="min-h-screen flex flex-col bg-canvas">
      {/* TOP BAR */}
      <header className="border-b border-line bg-panel/70 backdrop-blur-md sticky top-0 z-30 animate-fade">
        <div className="px-5 py-3 flex items-center gap-4">
          <button
            onClick={() => setSidebarOpen((s) => !s)}
            className="btn-ghost size-9 grid place-items-center rounded-md border border-line bg-panel hover:bg-canvas hover:border-ink/40"
            title="Properties & resolution chain"
            aria-label="Toggle properties sidebar"
          >
            <I.Menu size={16} />
          </button>
          <div className="flex items-center gap-3">
            <div className="size-8 rounded-md bg-ink text-canvas grid place-items-center font-mono text-[12px] shadow-panel">
              <I.Bolt size={14} />
            </div>
            <div>
              <div className="text-[13px] font-semibold leading-tight tracking-tight">
                Property Context Workbench
              </div>
              <div className="mono-label leading-tight flex items-center gap-1">
                file-native context compiler
                {aiStats?.enabled && (
                  <span
                    className={`ml-2 inline-flex items-center gap-1 px-1.5 py-[1px] rounded-full bg-ok/10 text-ok text-[9.5px] ai-on ${aiPulse ? "active" : ""}`}
                    title={`Model: ${aiStats.model}`}
                  >
                    <span className="dot bg-ok animate-pulse-soft" />
                    {aiStats.model.replace(/^(gemini|grok|claude)-/, "")}
                  </span>
                )}
              </div>
            </div>
          </div>

          <div className="flex-1 mx-4 relative">
            <div className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted">
              <I.Search size={13} />
            </div>
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search by UUID, unit (WE 04), email, invoice, vendor name…"
              className="w-full h-9 pl-8 pr-10 text-[13px] rounded-md bg-canvas border border-line focus:outline-none focus:border-ink placeholder:text-muted transition-colors"
            />
            <button
              type="button"
              onClick={toggleVoiceSearch}
              disabled={voiceState === "transcribing"}
              title={
                voiceState === "recording"
                  ? "Stop and transcribe (Gradium STT)"
                  : voiceState === "transcribing"
                    ? "Transcribing…"
                    : "Voice search (Gradium STT)"
              }
              className={`absolute right-1.5 top-1/2 -translate-y-1/2 h-7 w-7 rounded-md flex items-center justify-center transition-colors ${
                voiceState === "recording"
                  ? "bg-warn/15 text-warn animate-pulse-soft"
                  : voiceState === "transcribing"
                    ? "text-muted"
                    : "text-muted hover:text-ink hover:bg-canvas"
              }`}
            >
              <I.Mic size={14} />
            </button>
            {voiceError && (
              <div className="absolute mt-1 w-full panel shadow-panel z-40 px-3 py-2 text-[12px] text-warn animate-in">
                {voiceError}
              </div>
            )}
            {searchHits.length > 0 && (
              <div className="absolute mt-1 w-full panel shadow-panel z-40 max-h-72 overflow-auto animate-in">
                {searchHits.map((h, i) => (
                  <button
                    key={i}
                    onClick={() => {
                      setActiveId(h.property_id);
                      setQuery("");
                      setSearchHits([]);
                      setTab("context");
                    }}
                    className="w-full text-left px-3 py-2 text-[12.5px] hover:bg-canvas border-b border-line last:border-b-0 btn-ghost"
                  >
                    <span className="mono-label mr-2">{h.entity_type || "property"}</span>
                    <span className="font-medium">{h.entity_name || h.property_id}</span>
                    <span className="text-muted ml-2">→ {h.property_id}</span>
                    <span className="float-right mono-label">{h.matched_field}</span>
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="flex items-center gap-2">
            <label className="mono-label flex items-center gap-1.5 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={autoApply}
                onChange={(e) => setAutoApply(e.target.checked)}
                className="accent-ink"
              />
              auto-apply safe
            </label>
            <button
              onClick={buildAll}
              disabled={busy !== null}
              className="btn-ghost h-9 px-3 text-[12.5px] rounded-md border border-line bg-panel hover:bg-canvas hover:border-ink/40 disabled:opacity-50 inline-flex items-center gap-1.5"
            >
              <I.Build size={14} />
              Build All
            </button>

            {/* Ingest dropdown */}
            <div className="relative">
              <button
                onClick={() => setDayMenu((s) => !s)}
                disabled={busy !== null}
                className="btn-ghost h-9 px-3 text-[12.5px] rounded-md bg-ink text-canvas hover:opacity-90 disabled:opacity-50 inline-flex items-center gap-1.5"
              >
                <I.Inbox size={14} />
                Ingest
                {nextFreshDay && (
                  <span className="ml-1 px-1.5 rounded bg-canvas/20 text-[10.5px] font-mono">
                    {nextFreshDay.day}
                  </span>
                )}
                <I.Chevron size={12} className={`transition-transform ${dayMenu ? "rotate-180" : ""}`} />
              </button>
              {dayMenu && (
                <div className="absolute right-0 mt-1 panel shadow-panel z-40 w-80 animate-in">
                  <div className="p-2 border-b border-line flex items-center justify-between">
                    <div className="mono-label">incremental days</div>
                    <button
                      onClick={() => ingestDay("all")}
                      className="btn-ghost text-[11px] px-2 h-6 rounded bg-ink text-canvas hover:opacity-90"
                    >
                      ingest all
                    </button>
                  </div>
                  <ul className="max-h-80 overflow-auto stagger">
                    {days.map((d) => (
                      <li key={d.day}>
                        <button
                          onClick={() => ingestDay(d.day)}
                          disabled={busy !== null}
                          className="btn-ghost w-full text-left px-3 py-2 text-[12px] hover:bg-canvas border-b border-line last:border-b-0 flex items-center gap-2"
                        >
                          <I.Calendar size={12} className="text-muted" />
                          <span className="font-mono">{d.day}</span>
                          {d.content_date && (
                            <span className="text-muted text-[11px]">{d.content_date}</span>
                          )}
                          <span className="ml-auto flex items-center gap-1.5">
                            <span className="mono-label">
                              {d.ingested_count}/{d.total_files}
                            </span>
                            <DayBadge status={d.status} />
                          </span>
                        </button>
                      </li>
                    ))}
                    {days.length === 0 && (
                      <li className="px-3 py-3 text-muted text-[12px]">
                        No incremental days found in <code>incremental/</code>.
                      </li>
                    )}
                  </ul>
                </div>
              )}
            </div>
          </div>
        </div>
        <div className="px-5 pb-3 flex flex-wrap gap-x-6 gap-y-1 items-center">
          <Stat icon={<I.File size={11} />} label="files indexed" value={metrics?.total_files ?? "—"} />
          <Stat icon={<I.Building size={11} />} label="properties" value={properties.length} />
          <Stat icon={<I.Inbox size={11} />} label="pending" value={metrics?.pending_count ?? 0} />
          <Stat
            icon={<I.Warn size={11} />}
            label="needs review"
            value={metrics?.pending_review_count ?? 0}
            tone={(metrics?.pending_review_count ?? 0) > 0 ? "warn" : undefined}
          />
          <Stat
            label="unresolved"
            value={metrics?.unresolved_count ?? 0}
            tone={(metrics?.unresolved_count ?? 0) > 0 ? "flag" : undefined}
          />
          <Stat
            icon={<I.Clock size={11} />}
            label="avg incremental"
            value={metrics?.avg_incremental_ms ? `${metrics.avg_incremental_ms} ms` : "—"}
          />
          {aiStats?.enabled && (
            <Stat
              icon={<I.Spark size={11} />}
              label="ai"
              value={`${aiStats.success}/${aiStats.calls}${aiStats.avg_ms ? ` · ${aiStats.avg_ms}ms` : ""}${aiStats.retries ? ` · ${aiStats.retries}r` : ""}${aiStats.failed ? ` · ${aiStats.failed} fail` : ""}`}
              tone={aiStats.failed > 0 ? "warn" : "ok"}
            />
          )}
          {aiStats?.enabled && (aiStats.input_tokens > 0 || aiStats.output_tokens > 0) && (
            <Stat
              icon={<I.Spark size={11} />}
              label="tokens"
              value={`${formatTokens(aiStats.input_tokens)} in · ${formatTokens(aiStats.output_tokens)} out${aiStats.cache_read_tokens ? ` · ${formatTokens(aiStats.cache_read_tokens)} cached` : ""}`}
            />
          )}
          {busy && (
            <span className="mono-label text-warn ml-auto inline-flex items-center gap-2">
              <span className="size-3 rounded-full border-2 border-warn border-t-transparent animate-spin-slow" />
              {busy}
            </span>
          )}
          {toast && !busy && (
            <span className="mono-label text-ok ml-auto inline-flex items-center gap-1 animate-in">
              <I.Check size={12} />
              {toast}
            </span>
          )}
        </div>
      </header>

      {/* MAIN GRID */}
      <main className="flex-1 flex gap-4 p-4 grid-bg overflow-hidden">
        {/* CENTER: Context */}
        <section className="flex-1 min-w-0 panel overflow-hidden flex flex-col max-h-[calc(100vh-152px)] animate-in transition-[flex] duration-300">
          <div className="border-b border-line px-4 pt-3 pb-2.5 flex items-center justify-between gap-2">
            <div className="flex items-center gap-2.5 min-w-0">
              <span className="size-7 rounded-lg bg-canvas border border-line grid place-items-center shrink-0">
                <I.Building size={13} className="text-ink/70" />
              </span>
              <div className="min-w-0">
                <div className="text-[13px] font-semibold tracking-tight text-ink truncate leading-tight">
                  {propState?.name || "—"}
                </div>
                <div className="mono-label leading-tight mt-0.5">
                  {propState?.property_id || "no property selected"}
                </div>
              </div>
            </div>
            <div className="inline-flex bg-canvas/70 rounded-lg p-[3px] border border-line/80">
              {(["context", "sources"] as Tab[]).map((t) => (
                <button
                  key={t}
                  onClick={() => setTab(t)}
                  className={`btn-ghost px-3.5 h-7 text-[11.5px] mono-label rounded-[7px] transition-all ${
                    tab === t
                      ? "bg-panel text-ink shadow-[0_1px_2px_rgba(0,0,0,0.06),0_0_0_0.5px_rgba(0,0,0,0.06)]"
                      : "hover:text-ink text-muted"
                  }`}
                >
                  {t}
                </button>
              ))}
            </div>
          </div>
          <div key={tab} className="flex-1 overflow-auto p-5 animate-fade">
            {!propState && (
              <div className="text-muted text-[13px]">
                Select a property or run <em>Build All</em> first.
              </div>
            )}
            {propState && tab === "context" && (
              <ContextView
                state={propState}
                raw={rawMd}
                setRaw={setRawMd}
                onEdited={() => refreshProperty(propState.property_id)}
                log={log}
              />
            )}
            {propState && tab === "sources" && <SourcesView state={propState} />}
          </div>
        </section>

        {/* RIGHT: Pending Updates — collapsible */}
        {pendingCollapsed ? (
          <button
            onClick={() => setPendingCollapsed(false)}
            className="btn-ghost shrink-0 w-10 panel flex flex-col items-center justify-start gap-3 py-3 hover:border-ink/40 transition-colors max-h-[calc(100vh-152px)]"
            title="Expand pending updates"
          >
            <I.Chevron size={14} className="rotate-90 text-muted" />
            <I.Inbox size={14} className="text-muted" />
            <span className="text-[11px] tabular-nums font-mono text-muted">
              {pending.length}
            </span>
            {(() => {
              const reviewN = pending.filter((p) => p.decision.needs_review).length;
              return reviewN > 0 ? (
                <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-flag/10 text-flag inline-flex items-center gap-1 leading-none">
                  <I.Warn size={9} />
                  {reviewN}
                </span>
              ) : null;
            })()}
            <span
              className="mono-label text-[9.5px] mt-1"
              style={{ writingMode: "vertical-rl", transform: "rotate(180deg)" }}
            >
              pending updates
            </span>
          </button>
        ) : (
        <aside className="w-[480px] shrink-0 panel p-3 overflow-auto max-h-[calc(100vh-152px)] animate-in">
          <div className="flex items-center justify-between mb-3">
            <SectionLabel icon={<I.Inbox size={11} />}>Pending updates</SectionLabel>
            <div className="flex items-center gap-1.5">
              {(() => {
                const reviewN = pending.filter((p) => p.decision.needs_review).length;
                return reviewN > 0 ? (
                  <span className="text-[10.5px] px-1.5 h-[18px] rounded-full bg-flag/10 text-flag inline-flex items-center gap-1 leading-none">
                    <I.Warn size={9} />
                    {reviewN} review
                  </span>
                ) : null;
              })()}
              <span className="text-[11px] tabular-nums font-mono text-muted">
                {pending.length}
              </span>
              <button
                onClick={() => setPendingCollapsed(true)}
                className="btn-ghost size-6 grid place-items-center rounded hover:bg-canvas border border-line"
                title="Collapse pending"
                aria-label="Collapse pending"
              >
                <I.Chevron size={11} className="-rotate-90 text-muted" />
              </button>
            </div>
          </div>
          {pending.length > 0 && (() => {
            const counts = {
              all: pending.length,
              review: pending.filter((p) => p.decision.needs_review).length,
              durable: pending.filter((p) => p.decision.decision === "durable_fact").length,
              operational: pending.filter((p) => p.decision.decision === "operational_memory").length,
              temporary: pending.filter((p) => p.decision.decision === "temporary_note").length,
              ignore: pending.filter((p) => p.decision.decision === "ignore").length,
            } as const;
            const tabs: { id: typeof pendingFilter; label: string }[] = [
              { id: "all", label: "All" },
              { id: "review", label: "Review" },
              { id: "durable", label: "Durable" },
              { id: "operational", label: "Op" },
              { id: "temporary", label: "Temp" },
              { id: "ignore", label: "Ignore" },
            ];
            return (
              <div className="flex flex-wrap gap-1 mb-3">
                {tabs.map((t) => {
                  const active = pendingFilter === t.id;
                  const n = counts[t.id];
                  const empty = n === 0;
                  return (
                    <button
                      key={t.id}
                      onClick={() => setPendingFilter(t.id)}
                      disabled={empty && !active}
                      className={`text-[11px] h-6 pl-2.5 pr-1.5 rounded-full inline-flex items-center gap-1.5 transition-all ${
                        active
                          ? "bg-ink text-white shadow-[0_1px_2px_rgba(0,0,0,0.1)]"
                          : empty
                            ? "text-muted/50 cursor-default"
                            : "text-muted hover:text-ink hover:bg-canvas"
                      }`}
                    >
                      <span>{t.label}</span>
                      <span
                        className={`text-[10px] tabular-nums px-1.5 rounded-full leading-[15px] min-w-[18px] text-center ${
                          active
                            ? "bg-white/15 text-white/85"
                            : "bg-canvas text-muted/70"
                        }`}
                      >
                        {n}
                      </span>
                    </button>
                  );
                })}
              </div>
            );
          })()}
          {pending.length === 0 && (
            <div className="text-muted text-[12.5px] border border-dashed border-line rounded p-3">
              <div className="mono-label mb-1">queue empty</div>
              Pick a day from <strong>Ingest</strong> to feed new files into the workbench.
            </div>
          )}
          <ul className="space-y-2 stagger">
            {pending
              .filter((p) => {
                if (pendingFilter === "all") return true;
                if (pendingFilter === "review") return p.decision.needs_review;
                if (pendingFilter === "durable") return p.decision.decision === "durable_fact";
                if (pendingFilter === "operational") return p.decision.decision === "operational_memory";
                if (pendingFilter === "temporary") return p.decision.decision === "temporary_note";
                if (pendingFilter === "ignore") return p.decision.decision === "ignore";
                return true;
              })
              .sort((a, b) => (b.decision.confidence ?? 0) - (a.decision.confidence ?? 0))
              .map((p) => (
                <PendingCard
                  key={p.source.id}
                  item={p}
                  onPreview={() => setDrawer(p)}
                  onApply={() => actOnPending(p.source.id, "apply")}
                  onReject={() => actOnPending(p.source.id, "reject")}
                  onTemp={() => actOnPending(p.source.id, "temporary")}
                />
              ))}
          </ul>
        </aside>
        )}
      </main>

      {/* SIDEBAR DRAWER (properties + resolution chain + matched/unresolved) */}
      {sidebarOpen && (
        <div className="fixed inset-0 z-40 flex animate-fade" onClick={() => setSidebarOpen(false)}>
          <div className="absolute inset-0 bg-ink/30 backdrop-blur-[2px]" />
          <aside
            onClick={(e) => e.stopPropagation()}
            className="relative w-[340px] h-full bg-panel border-r border-line shadow-panel overflow-auto p-3 animate-slide-right"
          >
            <div className="flex items-center justify-between mb-3">
              <div className="mono-label inline-flex items-center gap-1.5">
                <I.Menu size={12} /> navigation
              </div>
              <button
                onClick={() => setSidebarOpen(false)}
                className="btn-ghost size-7 grid place-items-center rounded hover:bg-canvas"
                aria-label="Close sidebar"
              >
                <I.X size={12} />
              </button>
            </div>

            <SectionLabel icon={<I.Building size={11} />}>Properties</SectionLabel>
            <ul className="space-y-1 mb-4 stagger">
              {properties.map((p) => (
                <li key={p.id}>
                  <button
                    onClick={() => {
                      setActiveId(p.id);
                      setTab("context");
                      setSidebarOpen(false);
                    }}
                    className={`btn-ghost w-full text-left px-2 py-1.5 rounded-md text-[12.5px] border ${activeId === p.id ? "border-ink bg-canvas" : "border-transparent hover:bg-canvas"}`}
                  >
                    <div className="flex items-center justify-between">
                      <span className="font-medium">{p.name}</span>
                      <span className="mono-label">{p.id}</span>
                    </div>
                    <div className="text-muted text-[11.5px] mt-0.5">{p.address}</div>
                  </button>
                </li>
              ))}
              {properties.length === 0 && (
                <li className="text-muted text-[12.5px]">
                  No properties yet — click <strong>Build All</strong>.
                </li>
              )}
            </ul>

            <SectionLabel icon={<I.Source size={11} />}>Resolution chain</SectionLabel>
            <div className="rounded-md border border-line bg-canvas/60 p-2 text-[11px] font-mono leading-relaxed mb-4 space-y-0.5">
              <div className="flex items-center gap-1">
                <I.Mail size={10} className="text-muted" />
                <span>email → contact → property</span>
              </div>
              <div className="flex items-center gap-1">
                <I.File size={10} className="text-muted" />
                <span>invoice → vendor → property</span>
              </div>
              <div className="flex items-center gap-1">
                <I.Bank size={10} className="text-muted" />
                <span>iban → account → property</span>
              </div>
              <div className="flex items-center gap-1">
                <I.Building size={10} className="text-muted" />
                <span>unit → building → property</span>
              </div>
            </div>

            <SectionLabel icon={<I.Check size={11} />}>
              Matched files ({matchedFiles.length})
            </SectionLabel>
            <ul className="space-y-1 mb-4">
              {matchedFiles.slice(0, 20).map((p) => (
                <li key={p.source.id}>
                  <button
                    onClick={() => {
                      setDrawer(p);
                      setSidebarOpen(false);
                    }}
                    className="btn-ghost w-full text-left text-[11.5px] font-mono px-2 py-1 rounded hover:bg-canvas inline-flex items-center gap-1.5"
                    title={p.source.rel_path}
                  >
                    <SourceIcon type={p.source.source_type} size={11} className="text-muted" />
                    <span className="truncate inline-block max-w-[240px] align-middle">
                      {basename(p.source.rel_path)}
                    </span>
                  </button>
                </li>
              ))}
              {matchedFiles.length === 0 && (
                <li className="text-muted text-[12.5px]">none yet</li>
              )}
            </ul>

            <SectionLabel icon={<I.Warn size={11} />}>
              Unresolved ({unresolvedFiles.length})
            </SectionLabel>
            <ul className="space-y-1">
              {unresolvedFiles.slice(0, 12).map((p) => (
                <li key={p.source.id}>
                  <button
                    onClick={() => {
                      setDrawer(p);
                      setSidebarOpen(false);
                    }}
                    className="btn-ghost w-full text-left text-[11.5px] font-mono px-2 py-1 rounded hover:bg-canvas text-flag"
                  >
                    {basename(p.source.rel_path)}
                  </button>
                </li>
              ))}
              {unresolvedFiles.length === 0 && (
                <li className="text-muted text-[12.5px]">all resolved</li>
              )}
            </ul>
          </aside>
        </div>
      )}

      {/* INGEST / BUILD LOADING OVERLAY */}
      {loadingTitle && (
        <LoadingOverlay
          title={loadingTitle}
          step={loadingStep}
          logs={logs}
          aiActive={aiPulse}
        />
      )}

      {/* BOTTOM DRAWER */}
      {drawer && (
        <Drawer
          item={drawer}
          onClose={() => setDrawer(null)}
          onApply={() => actOnPending(drawer.source.id, "apply")}
          onReject={() => actOnPending(drawer.source.id, "reject")}
        />
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  tone,
  icon,
}: {
  label: string;
  value: string | number;
  tone?: "warn" | "flag" | "ok";
  icon?: React.ReactNode;
}) {
  const color =
    tone === "warn"
      ? "text-warn"
      : tone === "flag"
        ? "text-flag"
        : tone === "ok"
          ? "text-ok"
          : "text-ink";
  return (
    <div className="flex items-center gap-1.5">
      {icon && <span className="text-muted">{icon}</span>}
      <span className="mono-label">{label}</span>
      <span className={`text-[12.5px] font-medium ${color} font-mono`}>{value}</span>
    </div>
  );
}

function SectionLabel({
  children,
  icon,
}: {
  children: React.ReactNode;
  icon?: React.ReactNode;
}) {
  return (
    <div className="mono-label mb-2 flex items-center gap-1.5">
      {icon}
      {children}
    </div>
  );
}

function DayBadge({ status }: { status: "fresh" | "partial" | "ingested" }) {
  if (status === "ingested") {
    return (
      <span className="inline-flex items-center gap-1 text-[10px] text-ok">
        <I.Check size={10} />
        ingested
      </span>
    );
  }
  if (status === "partial") {
    return (
      <span className="inline-flex items-center gap-1 text-[10px] text-warn">
        <span className="dot bg-warn" />
        partial
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 text-[10px] text-muted">
      <span className="dot bg-muted/60" />
      fresh
    </span>
  );
}

function basename(p: string) {
  return p.split("/").pop() || p;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

// strip HTML comments from rendered markdown view
function cleanForRender(md: string): string {
  return md.replace(/<!--[\s\S]*?-->/g, "");
}

function extractSections(md: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /<!--\s*ctx-section:id=([\w-]+)\s*-->([\s\S]*?)<!--\s*\/ctx-section\s*-->/g;
  let m;
  while ((m = re.exec(md))) {
    const id = m[1];
    const body = m[2].replace(/^##\s+[^\n]+\n?/, "").trim();
    out[id] = body;
  }
  return out;
}

function PendingCard({
  item,
  onPreview,
  onApply,
  onReject,
  onTemp,
}: {
  item: PendingItem;
  onPreview: () => void;
  onApply: () => void;
  onReject: () => void;
  onTemp: () => void;
}) {
  const d = item.decision;
  const fileName = basename(item.source.rel_path);
  const sectionLabel = d.target_sections[0]
    ? humanSection(d.target_sections[0])
    : null;
  const stop = (fn: () => void) => (e: React.MouseEvent) => {
    e.stopPropagation();
    fn();
  };
  const canApply = !!d.property_id && d.decision !== "ignore";

  return (
    <li
      onClick={onPreview}
      className={`group relative rounded-xl border bg-panel hover:shadow-panel transition-all cursor-pointer overflow-hidden ${
        d.needs_review
          ? "border-flag/30 bg-flag/[0.03] hover:border-flag/50"
          : "border-line hover:border-ink/30"
      }`}
    >
      {/* Status accent bar (Apple-style left rail) */}
      <span
        className={`absolute left-0 top-0 bottom-0 w-[3px] ${
          d.needs_review
            ? "bg-flag"
            : d.decision === "durable_fact"
              ? "bg-ink"
              : d.decision === "operational_memory"
                ? "bg-ink/40"
                : d.decision === "temporary_note"
                  ? "bg-warn"
                  : "bg-muted/40"
        }`}
        aria-hidden
      />

      <div className="p-4 pl-5">
        {/* Header: filename + needs-review pill */}
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div
              className="text-[13.5px] font-medium tracking-tight truncate inline-flex items-center gap-2"
              title={item.source.rel_path}
            >
              <SourceIcon
                type={item.source.source_type}
                size={13}
                className="text-muted shrink-0"
              />
              <span className="truncate">{fileName}</span>
            </div>
          </div>
          {d.needs_review && (
            <span
              className="text-[10.5px] px-2 py-0.5 rounded-full bg-flag/10 text-flag inline-flex items-center gap-1 shrink-0"
              title={d.review_reason ?? "Needs human review"}
            >
              <I.Warn size={10} />
              review
            </span>
          )}
        </div>

        {/* Summary — primary content */}
        <p className="text-[13px] leading-snug text-ink/85 mt-2 line-clamp-2">
          {d.summary}
        </p>

        {/* Meta row — single line, restrained */}
        <div className="flex items-center gap-2 mt-3 text-[11px] text-muted">
          <span className="inline-flex items-center gap-1">
            <DecisionIcon d={d.decision} size={10} />
            {d.decision.replace("_", " ")}
          </span>
          {sectionLabel && (
            <>
              <span className="text-line">·</span>
              <span className="truncate">{sectionLabel}</span>
            </>
          )}
          {(d.collapsed_followups ?? 0) > 0 && (
            <>
              <span className="text-line">·</span>
              <span title="email thread followups folded into this update">
                +{d.collapsed_followups} thread
              </span>
            </>
          )}
          <span className="ml-auto inline-flex items-center gap-1 font-mono">
            {d.source !== "rule" && <I.Spark size={9} className="text-ok" />}
            {(d.confidence * 100).toFixed(0)}%
          </span>
        </div>

        {/* Actions — appear on hover, primary always visible */}
        <div className="flex items-center gap-1.5 mt-3">
          <button
            onClick={stop(onApply)}
            disabled={!canApply}
            className="btn-ghost flex-1 h-8 rounded-md bg-ink text-canvas text-[12px] font-medium hover:opacity-90 disabled:opacity-30 disabled:cursor-not-allowed inline-flex items-center justify-center gap-1.5"
          >
            <I.Check size={12} /> Apply
          </button>
          <button
            onClick={stop(onTemp)}
            className="btn-ghost size-8 rounded-md border border-line hover:bg-canvas hover:border-warn/40 hover:text-warn grid place-items-center"
            title="Save as temporary note"
            aria-label="Save as temporary"
          >
            <I.Clock size={12} />
          </button>
          <button
            onClick={stop(onReject)}
            className="btn-ghost size-8 rounded-md border border-line hover:bg-canvas hover:border-flag/40 hover:text-flag grid place-items-center"
            title="Reject this update"
            aria-label="Reject"
          >
            <I.X size={12} />
          </button>
        </div>
      </div>
    </li>
  );
}

// Section titles that match lib/context-schema.ts. Kept in sync manually
// because this is the human-readable form.
const SECTION_TITLE_BY_ID: Record<string, string> = {
  identity: "Identity",
  units_and_occupants: "Units and Occupants",
  open_issues: "Open Issues",
  governance_and_owner_matters: "Governance / Owner Matters",
  vendors_and_service_references: "Vendors and Service References",
  finance_and_open_items: "Finance and Open Items",
  recent_changes: "Recent Changes",
  conflicts_and_needs_review: "Conflicts / Needs Review",
  source_index: "Source Index",
};
const SECTION_RENDER_ORDER = [
  "identity",
  "units_and_occupants",
  "open_issues",
  "governance_and_owner_matters",
  "vendors_and_service_references",
  "finance_and_open_items",
  "recent_changes",
  "conflicts_and_needs_review",
  "source_index",
];

// Split a section body into runs of (humanBlock | normalBlock) so we can
// tint @human regions amber in the rendered view. The challenge wants
// "human edits visible" — a colored stripe makes it obvious at a glance.
interface MdBlock {
  kind: "human" | "normal";
  body: string;
  meta?: string;
}
function splitHumanBlocks(md: string): MdBlock[] {
  const re =
    /<!--\s*@human\s+start(?:\s+([^>]*?))?\s*-->([\s\S]*?)<!--\s*@human\s+end\s*-->/g;
  const out: MdBlock[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(md))) {
    if (m.index > last) {
      out.push({ kind: "normal", body: md.slice(last, m.index) });
    }
    out.push({ kind: "human", body: m[2].trim(), meta: (m[1] || "").trim() });
    last = re.lastIndex;
  }
  if (last < md.length) out.push({ kind: "normal", body: md.slice(last) });
  return out;
}

function ContextView({
  state,
  raw,
  setRaw,
  onEdited,
  log,
}: {
  state: PropertyState;
  raw: boolean;
  setRaw: (v: boolean) => void;
  onEdited: () => void;
  log: (
    msg: string,
    kind?: "info" | "ai" | "ok" | "warn" | "step",
  ) => void;
}) {
  const sections = extractSections(state.context_md);
  const [editingId, setEditingId] = useState<string | null>(null);
  // Collapsed state per section. Default: all expanded except the long ones
  // (units_and_occupants), so the page is scannable on first load.
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const toggle = (id: string) =>
    setCollapsed((c) => ({ ...c, [id]: !c[id] }));
  const setAll = (v: boolean) => {
    const next: Record<string, boolean> = {};
    for (const id of SECTION_RENDER_ORDER) next[id] = v;
    setCollapsed(next);
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <SectionLabel icon={<I.File size={11} />}>Context.md</SectionLabel>
        <div className="flex items-center gap-3">
          <span className="mono-label inline-flex items-center gap-1.5">
            <span className="inline-block w-2 h-2 rounded-sm bg-warn/70" />
            human edits preserved
          </span>
          {!raw && (
            <div className="flex items-center gap-0.5 border border-line rounded-md bg-canvas/40 p-0.5">
              <button
                onClick={() => setAll(false)}
                className="btn-ghost text-[10.5px] mono-label px-2 h-6 rounded hover:bg-panel"
                title="Expand all sections"
              >
                expand
              </button>
              <button
                onClick={() => setAll(true)}
                className="btn-ghost text-[10.5px] mono-label px-2 h-6 rounded hover:bg-panel"
                title="Collapse all sections"
              >
                collapse
              </button>
            </div>
          )}
          <label className="mono-label flex items-center gap-1.5 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={raw}
              onChange={(e) => setRaw(e.target.checked)}
              className="accent-ink"
            />
            raw markdown
          </label>
        </div>
      </div>

      {raw ? (
        <pre className="text-[11.5px] font-mono whitespace-pre-wrap leading-snug bg-canvas/60 border border-line rounded-md p-3">
          {state.context_md}
        </pre>
      ) : (
        <div className="space-y-3 animate-fade">
          {SECTION_RENDER_ORDER.map((id) => {
            const body = sections[id] ?? "";
            const title = SECTION_TITLE_BY_ID[id] ?? id;
            const isEditing = editingId === id;
            const blocks = splitHumanBlocks(body);
            return (
              <div
                key={id}
                className="border border-line rounded-lg overflow-hidden bg-canvas/30"
              >
                <div className="flex items-center justify-between px-3 py-1.5 bg-canvas/50 border-b border-line">
                  <h3 className="text-[12px] font-semibold tracking-wide uppercase text-muted">
                    {title}
                  </h3>
                  <button
                    onClick={() =>
                      setEditingId(isEditing ? null : id)
                    }
                    className="btn-ghost text-[11px] px-2 h-6 rounded inline-flex items-center gap-1 border border-line hover:border-ink/40"
                    title="Add a human note to this section"
                  >
                    <I.Edit size={10} />
                    {isEditing ? "cancel" : "edit"}
                  </button>
                </div>

                {isEditing ? (
                  <SectionEditor
                    propertyId={state.property_id}
                    sectionId={id}
                    onSaved={() => {
                      setEditingId(null);
                      onEdited();
                      log(`saved manual note → ${title}`, "ok");
                    }}
                    onError={(msg) => log(`edit failed: ${msg}`, "warn")}
                  />
                ) : (
                  <div className="px-3 py-2 prose-ctx">
                    {blocks.length === 0 || (blocks.length === 1 && !blocks[0].body.trim()) ? (
                      <p className="text-muted text-[12px] italic m-0">
                        (no information yet)
                      </p>
                    ) : (
                      blocks.map((b, i) =>
                        b.kind === "human" ? (
                          <div
                            key={i}
                            className="my-1.5 border-l-2 border-warn/70 pl-3 bg-warn/[0.04] rounded-r"
                          >
                            <div className="mono-label text-[10px] mb-0.5 text-warn/80">
                              human note {b.meta ? `· ${b.meta}` : ""}
                            </div>
                            <ReactMarkdown remarkPlugins={[remarkGfm]}>
                              {cleanForRender(b.body)}
                            </ReactMarkdown>
                          </div>
                        ) : (
                          <ReactMarkdown
                            key={i}
                            remarkPlugins={[remarkGfm]}
                          >
                            {cleanForRender(b.body)}
                          </ReactMarkdown>
                        ),
                      )
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function SectionEditor({
  propertyId,
  sectionId,
  onSaved,
  onError,
}: {
  propertyId: string;
  sectionId: string;
  onSaved: () => void;
  onError: (msg: string) => void;
}) {
  const [text, setText] = useState("");
  const [saving, setSaving] = useState(false);
  return (
    <div className="px-3 py-2.5 space-y-2">
      <textarea
        className="w-full text-[12.5px] font-mono leading-snug border border-line rounded p-2 bg-canvas/60 focus:outline-none focus:border-ink/40 resize-y min-h-[100px]"
        placeholder="Add a manual note for this section. It will be preserved across AI updates and shown with an amber stripe."
        value={text}
        onChange={(e) => setText(e.target.value)}
        autoFocus
      />
      <div className="flex items-center justify-between">
        <span className="mono-label text-[10px] text-muted">
          wrapped as <code>@human</code> block · never overwritten
        </span>
        <button
          disabled={saving || !text.trim()}
          onClick={async () => {
            setSaving(true);
            try {
              const r = await fetch(
                `/api/properties/${propertyId}/context-edit`,
                {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    section: sectionId,
                    body: text.trim(),
                    who: "ui",
                  }),
                },
              );
              if (!r.ok) {
                const err = await r.json().catch(() => ({}));
                throw new Error(err.error || `HTTP ${r.status}`);
              }
              onSaved();
            } catch (e) {
              onError((e as Error).message);
            } finally {
              setSaving(false);
            }
          }}
          className="btn-ghost text-[11px] px-3 h-7 rounded bg-ink text-canvas disabled:opacity-40 inline-flex items-center gap-1.5"
        >
          <I.Check size={10} /> {saving ? "saving…" : "save note"}
        </button>
      </div>
    </div>
  );
}

function SourcesView({ state }: { state: PropertyState }) {
  const grouped = new Map<string, Record<string, unknown>[]>();
  for (const s of state.sources) {
    const t = (s.source_type as string) || "other";
    const arr = grouped.get(t) ?? [];
    arr.push(s);
    grouped.set(t, arr);
  }
  return (
    <div className="space-y-4 stagger">
      {[...grouped.entries()].map(([k, items]) => (
        <div key={k}>
          <SectionLabel icon={<SourceIcon type={k} size={11} />}>
            {k} ({items.length})
          </SectionLabel>
          <ul className="space-y-1 text-[12px] font-mono">
            {items.slice(0, 100).map((s, i) => (
              <li
                key={i}
                className="flex items-center justify-between border border-line rounded px-2 py-1 bg-canvas/40"
              >
                <span className="truncate inline-flex items-center gap-1.5">
                  <SourceIcon type={k} size={11} className="text-muted shrink-0" />
                  {basename(s.rel_path as string)}
                </span>
                <span className="mono-label ml-2">{(s.bucket as string) || "base"}</span>
              </li>
            ))}
            {items.length > 100 && (
              <li className="text-muted">+ {items.length - 100} more…</li>
            )}
          </ul>
        </div>
      ))}
      {grouped.size === 0 && (
        <div className="text-muted text-[12.5px]">No sources indexed yet.</div>
      )}
    </div>
  );
}

function SourcePath({ path }: { path: string }) {
  const parts = path.split("/").filter(Boolean);
  const file = parts.pop() ?? path;
  return (
    <div className="flex items-baseline gap-1.5 min-w-0">
      {parts.length > 0 && (
        <div className="font-mono text-[11px] text-muted truncate">
          {parts.map((seg, i) => (
            <span key={i}>
              {seg}
              <span className="text-line mx-1">/</span>
            </span>
          ))}
        </div>
      )}
      <div className="font-mono text-[13px] font-medium text-ink truncate" title={path}>
        {file}
      </div>
    </div>
  );
}

function Drawer({
  item,
  onClose,
  onApply,
  onReject,
}: {
  item: PendingItem;
  onClose: () => void;
  onApply: () => void;
  onReject: () => void;
}) {
  return (
    <div className="fixed inset-0 z-40 flex items-end animate-fade" onClick={onClose}>
      <div className="absolute inset-0 bg-ink/30 backdrop-blur-[2px]" />
      <div
        onClick={(e) => e.stopPropagation()}
        className="relative w-full max-h-[78vh] bg-panel border-t border-line rounded-t-xl shadow-panel flex flex-col animate-drawer"
      >
        <div className="flex items-center justify-between px-5 py-3 border-b border-line gap-4">
          <div className="flex items-center gap-2.5 min-w-0">
            <SourceIcon type={item.source.source_type} size={16} className="text-muted shrink-0" />
            <div className="min-w-0">
              <div className="mono-label">source</div>
              <SourcePath path={item.source.rel_path} />
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              onClick={onReject}
              className="btn-ghost text-[12px] px-3 h-8 rounded border border-line hover:bg-canvas hover:border-flag/40 hover:text-flag inline-flex items-center gap-1.5"
            >
              <I.X size={12} /> Reject
            </button>
            <button
              onClick={onApply}
              disabled={!item.decision.property_id || item.decision.decision === "ignore"}
              className="btn-ghost text-[12px] px-3.5 h-8 rounded bg-ink text-canvas hover:opacity-90 disabled:opacity-40 inline-flex items-center gap-1.5"
            >
              <I.Check size={12} /> Apply
            </button>
            <button
              onClick={onClose}
              className="btn-ghost text-[12px] px-2 h-8 rounded hover:bg-canvas ml-1"
              aria-label="Close"
            >
              <I.X size={12} />
            </button>
          </div>
        </div>
        <div className="grid grid-cols-12 gap-4 p-5 overflow-auto">
          <div className="col-span-7 space-y-4">
            <ChangeSummary item={item} />
            <SourceExcerpt item={item} />
            <WillChangeCard item={item} />
            <ProposedFacts item={item} />
          </div>
          <div className="col-span-5 space-y-4">
            <WhyCard item={item} />
            <LinkedEntities item={item} />
            <details className="rounded-md border border-line bg-canvas/40 group">
              <summary className="cursor-pointer px-3 py-2 mono-label inline-flex items-center gap-1.5 select-none">
                <I.Source size={11} /> classifier output (raw)
                <I.Chevron size={10} className="ml-auto transition-transform group-open:rotate-180" />
              </summary>
              <pre className="text-[11px] font-mono whitespace-pre-wrap leading-snug border-t border-line p-3 max-h-72 overflow-auto">
                {JSON.stringify(
                  {
                    property_id: item.decision.property_id,
                    entity_ids: item.decision.entity_ids,
                    decision: item.decision.decision,
                    target_sections: item.decision.target_sections,
                    summary: item.decision.summary,
                    proposed_facts: item.decision.proposed_facts ?? {},
                    confidence: item.decision.confidence,
                    needs_review: item.decision.needs_review,
                    review_reason: item.decision.review_reason,
                    citations: item.decision.citations,
                  },
                  null,
                  2,
                )}
              </pre>
            </details>
            <details className="rounded-md border border-line bg-canvas/40 group">
              <summary className="cursor-pointer px-3 py-2 mono-label inline-flex items-center gap-1.5 select-none">
                <I.Diff size={11} /> unified diff (raw)
                <I.Chevron size={10} className="ml-auto transition-transform group-open:rotate-180" />
              </summary>
              <pre className="text-[11px] font-mono whitespace-pre-wrap leading-snug border-t border-line p-3 max-h-72 overflow-auto">
                {colorizeDiffPreview(
                  item.diff_preview ||
                    "(no changes — likely ignored or unresolved)",
                )}
              </pre>
            </details>
          </div>
        </div>
      </div>
    </div>
  );
}

function colorizeDiffPreview(diff: string): React.ReactNode {
  return diff.split("\n").map((l, i) => {
    let cls = "";
    if (l.startsWith("+") && !l.startsWith("+++")) cls = "text-ok";
    else if (l.startsWith("-") && !l.startsWith("---")) cls = "text-flag";
    else if (l.startsWith("@@")) cls = "text-warn";
    return (
      <span key={i} className={cls}>
        {l + "\n"}
      </span>
    );
  });
}

// ---------- Drawer helpers: human-friendly change view ----------

function humanSection(id: string): string {
  return id
    .replace(/_/g, " ")
    .replace(/\band\b/g, "&")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

interface ParsedDiff {
  added: string[];
  removed: string[];
  hunks: number;
}

function parseDiff(diff: string): ParsedDiff {
  const added: string[] = [];
  const removed: string[] = [];
  let hunks = 0;
  for (const raw of diff.split("\n")) {
    if (!raw) continue;
    if (raw.startsWith("===") || raw.startsWith("---") || raw.startsWith("+++")) continue;
    if (raw.startsWith("@@")) {
      hunks++;
      continue;
    }
    if (raw.startsWith("+")) {
      const t = raw.slice(1).trim();
      if (t && !t.startsWith("<!--")) added.push(t);
    } else if (raw.startsWith("-")) {
      const t = raw.slice(1).trim();
      if (t && !t.startsWith("<!--")) removed.push(t);
    }
  }
  return { added, removed, hunks };
}

function ChangeSummary({ item }: { item: PendingItem }) {
  const d = item.decision;
  const parsed = parseDiff(item.diff_preview || "");
  const supersedes =
    !!d.fact_key &&
    (item.before?.includes(`fact-key:${d.fact_key}`) ?? false);
  const action =
    parsed.added.length && parsed.removed.length
      ? "update"
      : parsed.added.length
        ? "add to"
        : parsed.removed.length
          ? "remove from"
          : "no change in";
  const verbColor =
    action === "add to"
      ? "text-ok"
      : action === "remove from"
        ? "text-flag"
        : action === "update"
          ? "text-warn"
          : "text-muted";
  const sections = d.target_sections.length ? d.target_sections : ["(no section)"];
  return (
    <div className="rounded-lg border border-line bg-canvas/40 p-4">
      <div className="mono-label mb-1.5 inline-flex items-center gap-1.5">
        <I.Bolt size={11} /> proposed change
      </div>
      <div className="text-[14px] leading-snug">
        AI proposes to{" "}
        <span className={`font-semibold ${verbColor}`}>{action}</span>{" "}
        {sections.map((s, i) => (
          <span key={s}>
            {i > 0 && " · "}
            <span className="px-1.5 py-0.5 rounded bg-panel border border-line font-medium text-ink">
              §{humanSection(s)}
            </span>
          </span>
        ))}
        {d.property_id && (
          <>
            {" "}of{" "}
            <span className="font-mono text-[12.5px]">{d.property_id}</span>
          </>
        )}
        .
      </div>
      <div className="text-[12.5px] text-ink/80 mt-2 italic">{d.summary}</div>
      {supersedes && (
        <div className="mt-2 text-[12px] inline-flex items-center gap-1.5 text-warn bg-warn/10 border border-warn/30 rounded px-2 py-1">
          <I.Warn size={11} />
          Supersedes an existing fact
          <span className="font-mono text-[11px] ml-1">{d.fact_key}</span>
          <span className="text-muted ml-1">
            — older line will be struck through and a conflict note added.
          </span>
        </div>
      )}
      <div className="flex flex-wrap gap-3 mt-3 text-[11.5px]">
        {parsed.added.length > 0 && (
          <span className="inline-flex items-center gap-1 text-ok">
            <I.Check size={11} /> {parsed.added.length} line{parsed.added.length > 1 ? "s" : ""} added
          </span>
        )}
        {parsed.removed.length > 0 && (
          <span className="inline-flex items-center gap-1 text-flag">
            <I.X size={11} /> {parsed.removed.length} line{parsed.removed.length > 1 ? "s" : ""} removed
          </span>
        )}
        {parsed.hunks > 1 && (
          <span className="mono-label">across {parsed.hunks} regions</span>
        )}
        <span className="mono-label ml-auto inline-flex items-center gap-1">
          <DecisionIcon d={d.decision} size={10} />
          {d.decision.replace("_", " ")}
        </span>
      </div>
    </div>
  );
}

function WillChangeCard({ item }: { item: PendingItem }) {
  const d = item.decision;
  const facts = d.facts ?? [];
  const parsed = parseDiff(item.diff_preview || "");
  const hasChanges = parsed.added.length > 0 || parsed.removed.length > 0;

  if (!hasChanges && facts.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-line p-4 text-muted text-[12.5px]">
        Nothing to write. The AI judged this document carries no new information
        relative to the current Context.md.
        {d.reasoning && (
          <div className="mt-1.5 text-[12px] italic">{d.reasoning}</div>
        )}
      </div>
    );
  }

  const supersededLines = parsed.added.filter((l) => l.startsWith("~~"));
  const isSupersession = supersededLines.length > 0;
  const stamp = new Date().toISOString().slice(0, 10);
  const srcFile = basename(d.citations?.[0] ?? item.source.rel_path);

  // Group facts by their target section.
  const factsBySection = new Map<string, typeof facts>();
  for (const f of facts) {
    const arr = factsBySection.get(f.section) ?? [];
    arr.push(f);
    factsBySection.set(f.section, arr);
  }
  const sections =
    factsBySection.size > 0
      ? Array.from(factsBySection.keys())
      : d.target_sections.length
        ? d.target_sections
        : ["recent_changes"];

  return (
    <div className="rounded-xl border border-line overflow-hidden">
      <div className="px-4 py-2.5 border-b border-line bg-panel flex items-center justify-between">
        <div className="text-[12px] font-medium text-ink inline-flex items-center gap-1.5">
          <I.Diff size={12} className="text-muted" />
          What will change
        </div>
        <div className="text-[11px] text-muted font-mono">
          {facts.length > 0
            ? `${facts.length} fact${facts.length === 1 ? "" : "s"}`
            : `+${parsed.added.length - supersededLines.length}${
                parsed.removed.length > 0 ? ` -${parsed.removed.length}` : ""
              }`}
        </div>
      </div>
      <div className="divide-y divide-line">
        {sections.map((section) => {
          const sectionFacts = factsBySection.get(section) ?? [];
          return (
            <div key={section} className="px-4 py-3">
              <div className="flex items-center gap-2 mb-2">
                <span className="text-[11px] uppercase tracking-wider text-muted font-medium">
                  Section
                </span>
                <span className="text-[12.5px] font-medium">
                  §{humanSection(section)}
                </span>
              </div>

              {isSupersession && sectionFacts.length === 0 && (
                <div className="mb-2 rounded-md bg-flag/[0.04] border border-flag/15 p-2.5">
                  <div className="flex items-center gap-1.5 text-[10.5px] uppercase tracking-wider text-flag/80 font-medium mb-1">
                    <I.X size={10} /> Removed
                  </div>
                  <div className="text-[12.5px] text-flag/80 line-through opacity-80">
                    {supersededLines[0].replace(/^~~|~~.*$/g, "").trim()}
                  </div>
                </div>
              )}

              {sectionFacts.length > 0 ? (
                <ul className="space-y-1.5">
                  {sectionFacts.map((f, i) => (
                    <li
                      key={f.key + i}
                      className="rounded-md bg-ok/[0.05] border border-ok/15 p-2.5"
                    >
                      <div className="flex items-baseline gap-2 text-[13px]">
                        <span className="font-medium text-ink">{f.label}:</span>
                        <span className="font-mono text-[12.5px] break-all">
                          {f.value}
                        </span>
                      </div>
                      {f.qualifier && (
                        <div className="text-muted text-[11px] mt-0.5">
                          {f.qualifier}
                        </div>
                      )}
                    </li>
                  ))}
                  <li className="text-[11px] text-muted font-mono pt-1">
                    source: {srcFile} · {stamp}
                  </li>
                </ul>
              ) : (
                <div className="rounded-md bg-ok/[0.05] border border-ok/15 p-2.5">
                  <div className="flex items-center gap-1.5 text-[10.5px] uppercase tracking-wider text-ok/80 font-medium mb-1">
                    <I.Check size={10} /> {isSupersession ? "Replaced with" : "New entry"}
                  </div>
                  <div className="text-[13px] leading-snug text-ink">{d.summary}</div>
                  <div className="text-[11px] text-muted font-mono mt-1.5 truncate">
                    source: {srcFile} · {stamp}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function SourceExcerpt({ item }: { item: PendingItem }) {
  const text = item.parsedTextPreview || "";
  // Surface meaningful sentences from the source — drops salutations,
  // signatures, quoted-reply blocks, disclaimers. Highlights spans that
  // matched relevance signals so the reviewer sees *why* this passed the gate.
  const lines = useMemo(() => extractExcerpt(text), [text]);
  const additionalCitations =
    (item.decision.citations || []).slice(1).filter(Boolean);

  if (!text.trim()) return null;

  return (
    <div className="rounded-xl border border-line overflow-hidden">
      <div className="px-4 py-2.5 border-b border-line bg-panel flex items-center justify-between">
        <div className="text-[12px] font-medium inline-flex items-center gap-1.5">
          <SourceIcon
            type={item.source.source_type}
            size={12}
            className="text-muted"
          />
          From the source
        </div>
        <div className="text-[11px] text-muted font-mono truncate max-w-[60%]">
          {basename(item.source.rel_path)}
        </div>
      </div>
      <div className="px-4 py-3 space-y-1.5">
        {lines.map((line, i) => (
          <p
            key={i}
            className="text-[13px] leading-relaxed text-ink/90"
            // Highlight key phrases with subtle background — handled inline
            dangerouslySetInnerHTML={{ __html: highlightSignals(line) }}
          />
        ))}
        {lines.length === 0 && (
          <div className="text-muted text-[12.5px] italic">
            (no extractable sentences — see raw diff for full content)
          </div>
        )}
      </div>
      {additionalCitations.length > 0 && (
        <div className="px-4 py-2 border-t border-line bg-canvas/40 text-[11px] text-muted">
          <span className="mono-label mr-1.5">+ thread context:</span>
          {additionalCitations.length} earlier message
          {additionalCitations.length > 1 ? "s" : ""} folded in
        </div>
      )}
    </div>
  );
}

// Mirror of the classifier's salutation/signature filter, lighter-weight for UI.
const EXCERPT_SKIP_RE = [
  /^\s*sehr\s+geehrt(e|er|en|es)\b/i,
  /^\s*(liebe|lieber|hallo|hi|hey|guten\s+(tag|morgen|abend))\b/i,
  /^\s*(dear|hello|hi)\b/i,
  /^\s*(mit\s+freundlichen\s+grüßen|mfg|viele\s+grüße|beste\s+grüße|grüße)\b/i,
  /^\s*(best\s+regards|kind\s+regards|sincerely|thanks|regards)\b/i,
  /^\s*(--+|__+|==+)\s*$/,
  /^\s*(am\s+\d|on\s+\w+,)\s.+(schrieb|wrote):/i,
  /^\s*>/,
  /^\s*(diese\s+e-?mail|this\s+(e-?mail|message)\s+(is\s+)?(confidential|intended))/i,
  /^\s*(gesendet\s+von|sent\s+from)\s/i,
];

function extractExcerpt(text: string, maxLines = 6): string[] {
  const out: string[] = [];
  for (const raw of text.replace(/\r\n/g, "\n").split(/\n+/)) {
    const trimmed = raw.trim();
    if (!trimmed || trimmed.length < 8) continue;
    if (EXCERPT_SKIP_RE.some((re) => re.test(trimmed))) continue;
    out.push(trimmed);
    if (out.length >= maxLines) break;
  }
  return out;
}

const SIGNAL_HIGHLIGHTS: RegExp[] = [
  /\bIBAN\b|\bBIC\b/gi,
  /\bDE\d{2}[\s\d]{16,30}\b/g,
  /\d{1,3}(?:[.,]\d{3})*[.,]\d{2}\s*(€|EUR)/g,
  /\b(eigentumswechsel|verkauf|verkauft|kündigung|gekündigt|sonderumlage|hausgeld|nebenkosten|abrechnung|klage|anwalt|gericht|einspruch|mahnung|reparatur|defekt|leck|wasserschaden|heizung|aufzug|eigentümerversammlung|beschluss)\b/gi,
  /\bWE\s?\d{2}\b/gi,
];

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function highlightSignals(line: string): string {
  let out = escapeHtml(line);
  for (const re of SIGNAL_HIGHLIGHTS) {
    out = out.replace(re, (m) => `<mark class="signal-mark">${m}</mark>`);
  }
  return out;
}

function ProposedFacts({ item }: { item: PendingItem }) {
  const structuredFacts = item.decision.facts ?? [];
  const facts = item.decision.proposed_facts ?? {};
  const entries = Object.entries(facts);
  if (structuredFacts.length === 0 && entries.length === 0) return null;
  return (
    <div className="rounded-lg border border-line overflow-hidden">
      <div className="px-3 py-2 border-b border-line bg-panel mono-label inline-flex items-center gap-1.5 w-full">
        <I.Source size={11} /> facts to be written
      </div>
      {structuredFacts.length > 0 && (
        <ul className="divide-y divide-line">
          {structuredFacts.map((f, i) => (
            <li key={f.key + i} className="px-3 py-2 text-[12.5px]">
              <div className="flex items-baseline gap-2">
                <span className="font-medium text-ink">{f.label}:</span>
                <span className="font-mono text-[12px] break-all">{f.value}</span>
              </div>
              {f.qualifier && (
                <div className="text-muted text-[11px] mt-0.5">{f.qualifier}</div>
              )}
              <div className="mono-label text-[10px] mt-1 opacity-70">
                {f.section} · {f.key}
              </div>
            </li>
          ))}
        </ul>
      )}
      {entries.length > 0 && (
        <table className="w-full text-[12.5px] border-t border-line">
          <tbody>
            {entries.map(([k, v]) => (
              <tr key={k} className="border-t border-line first:border-t-0">
                <td className="px-3 py-1.5 mono-label align-top w-1/3 bg-canvas/40">{k}</td>
                <td className="px-3 py-1.5 font-mono text-[12px] break-all">
                  {typeof v === "string" || typeof v === "number" || typeof v === "boolean"
                    ? String(v)
                    : JSON.stringify(v)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function WhyCard({ item }: { item: PendingItem }) {
  const d = item.decision;
  return (
    <div className="rounded-lg border border-line bg-canvas/40 p-3">
      <div className="mono-label mb-1.5 inline-flex items-center gap-1.5">
        <I.Brain size={11} /> why this classification
      </div>
      <div className="text-[12.5px] leading-relaxed">{d.reasoning}</div>
      {d.review_reason && (
        <div className="text-warn mt-2 text-[12px] inline-flex items-start gap-1.5">
          <I.Warn size={12} className="mt-[2px] shrink-0" />
          <span>{d.review_reason}</span>
        </div>
      )}
      <div className="flex flex-wrap gap-3 mt-3 text-[11px] mono-label">
        <span className="inline-flex items-center gap-1">
          confidence
          <span className="text-ink font-mono">{(d.confidence * 100).toFixed(0)}%</span>
        </span>
        <span className="inline-flex items-center gap-1">
          source
          <span className="text-ink font-mono inline-flex items-center gap-1">
            {d.source !== "rule" && <I.Spark size={9} className="text-ok" />}
            {d.source}
          </span>
        </span>
      </div>
    </div>
  );
}

function LinkedEntities({ item }: { item: PendingItem }) {
  const d = item.decision;
  const cites = d.citations ?? [];
  return (
    <div className="rounded-lg border border-line bg-canvas/40 p-3">
      <div className="mono-label mb-2 inline-flex items-center gap-1.5">
        <I.Source size={11} /> linked records
      </div>
      <div className="space-y-1.5 text-[12px]">
        <div className="flex items-center gap-2">
          <span className="mono-label w-16">property</span>
          {d.property_id ? (
            <span className="font-mono px-1.5 py-0.5 rounded bg-ink text-canvas text-[11.5px]">
              {d.property_id}
            </span>
          ) : (
            <span className="text-flag inline-flex items-center gap-1">
              <I.Warn size={10} /> unresolved
            </span>
          )}
        </div>
        {d.entity_ids.length > 0 && (
          <div className="flex items-start gap-2">
            <span className="mono-label w-16 mt-0.5">entities</span>
            <div className="flex flex-wrap gap-1">
              {d.entity_ids.map((e) => (
                <span
                  key={e}
                  className="font-mono text-[11px] px-1.5 py-0.5 rounded bg-canvas border border-line"
                >
                  {e}
                </span>
              ))}
            </div>
          </div>
        )}
        {cites.length > 0 && (
          <div className="flex items-start gap-2">
            <span className="mono-label w-16 mt-0.5">cites</span>
            <div className="flex flex-col gap-0.5 text-[11px] font-mono">
              {cites.slice(0, 4).map((c, i) => (
                <span key={i} className="truncate text-muted" title={c}>
                  {c}
                </span>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

type LogEntry = { ts: number; msg: string; kind: "info" | "ai" | "ok" | "warn" | "step" };

function LoadingOverlay({
  title,
  step,
  logs,
  aiActive,
}: {
  title: string;
  step: number;
  logs: LogEntry[];
  aiActive: boolean;
}) {
  const steps: { icon: React.ReactNode; label: string; sub: string }[] = [
    {
      icon: <I.Scan size={14} />,
      label: "Scanning incremental folder",
      sub: "discovering new files in incremental/",
    },
    {
      icon: <I.File size={14} />,
      label: "Parsing source documents",
      sub: "emails · invoices · letters · bank lines",
    },
    {
      icon: <I.Source size={14} />,
      label: "Resolving entities",
      sub: "mapping to Mieter · Einheiten · Vendors · Konten",
    },
    {
      icon: <I.Brain size={14} />,
      label: "Classifying with AI",
      sub: "durable_fact · operational_memory · temporary_note",
    },
    {
      icon: <I.Diff size={14} />,
      label: "Generating diff patches",
      sub: "preparing reviewable Context.md updates",
    },
  ];
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center animate-fade">
      <div className="absolute inset-0 bg-ink/40 backdrop-blur-[3px]" />
      <div className="relative w-[640px] max-w-[92vw] bg-panel border border-line rounded-xl shadow-panel overflow-hidden animate-in">
        <div className="relative px-5 py-3 border-b border-line flex items-center gap-3 overflow-hidden">
          <div className="size-8 rounded-md bg-ink text-canvas grid place-items-center shadow-panel">
            <I.Bolt size={14} />
          </div>
          <div className="flex-1">
            <div className="text-[13px] font-semibold tracking-tight">{title}</div>
            <div className="mono-label inline-flex items-center gap-1.5">
              <span className="dot bg-ok animate-pulse-soft" />
              pipeline running
              {aiActive && (
                <span className="ml-2 inline-flex items-center gap-1 text-ok">
                  <I.Spark size={9} className="animate-spin-slow" />
                  ai active
                </span>
              )}
            </div>
          </div>
          <div className="text-[11px] mono-label">step {Math.min(step + 1, 5)} / 5</div>
        </div>

        <div className="relative px-5 py-4">
          <div className="scan-line" />
          <ul className="space-y-2.5">
            {steps.map((s, i) => {
              const state = i < step ? "done" : i === step ? "active" : "pending";
              return (
                <li
                  key={i}
                  className="step-row flex items-center gap-3 text-[12.5px]"
                  style={{ animationDelay: `${i * 60}ms` }}
                >
                  <div
                    className={`size-7 rounded-md grid place-items-center border ${
                      state === "done"
                        ? "bg-ok/10 border-ok/30 text-ok"
                        : state === "active"
                          ? "bg-ink text-canvas border-ink"
                          : "bg-canvas border-line text-muted"
                    }`}
                  >
                    {state === "done" ? (
                      <I.Check size={12} />
                    ) : state === "active" ? (
                      <span className="size-3 rounded-full border-2 border-canvas border-t-transparent animate-spin-slow" />
                    ) : (
                      s.icon
                    )}
                  </div>
                  <div className="flex-1">
                    <div
                      className={`font-medium ${state === "pending" ? "text-muted" : "text-ink"}`}
                    >
                      {s.label}
                    </div>
                    <div className="mono-label">{s.sub}</div>
                  </div>
                  {state === "active" && (
                    <div className="w-24 h-1 rounded bg-canvas overflow-hidden">
                      <div className="h-full w-1/2 bg-ink/70 shimmer-bar" />
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </div>

        <div className="border-t border-line bg-canvas/40 px-5 py-3">
          <div className="mono-label mb-1.5 inline-flex items-center gap-1.5">
            <I.Bolt size={10} /> live log
          </div>
          <div className="font-mono text-[11px] leading-snug max-h-44 overflow-auto space-y-0.5">
            {logs.length === 0 && (
              <div className="text-muted">waiting for first event…</div>
            )}
            {logs.slice(0, 30).map((l, i) => {
              const color =
                l.kind === "ok"
                  ? "text-ok"
                  : l.kind === "warn"
                    ? "text-flag"
                    : l.kind === "ai"
                      ? "text-ok"
                      : l.kind === "step"
                        ? "text-ink"
                        : "text-muted";
              const ts = new Date(l.ts).toLocaleTimeString([], {
                hour12: false,
                hour: "2-digit",
                minute: "2-digit",
                second: "2-digit",
              });
              return (
                <div key={l.ts + ":" + i} className={`log-line flex gap-2 ${color}`}>
                  <span className="text-muted shrink-0">{ts}</span>
                  {l.kind === "ai" && <I.Spark size={10} className="mt-[2px] shrink-0" />}
                  {l.kind === "ok" && <I.Check size={10} className="mt-[2px] shrink-0" />}
                  {l.kind === "warn" && <I.Warn size={10} className="mt-[2px] shrink-0" />}
                  <span className="break-all">{l.msg}</span>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
