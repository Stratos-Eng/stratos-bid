'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useToast } from '@/components/ui/toast';
import { ProjectViewer } from '@/components/projects/project-viewer';
import type { SignageItem } from '@/lib/stores/project-store';

type TakeoffItem = {
  id: string;
  runId: string;
  bidId: string;
  userId: string;
  tradeCode: string;
  itemKey: string;
  code: string | null;
  category: string;
  description: string;
  qtyNumber: number | null;
  qtyText: string | null;
  unit: string | null;
  confidence: number | null;
  status: string;
  createdAt: string;
  updatedAt: string;
};

type EvidenceRow = {
  finding: {
    id: string;
    runId: string;
    bidId: string;
    documentId: string;
    pageNumber: number | null;
    type: string;
    confidence: number | null;
    data: any;
    evidenceText: string | null;
    evidence: any;
    createdAt: string;
  };
  link: { id: string; itemId: string; findingId: string; weight: number | null; note: string | null; createdAt: string };
};

function confLabel(conf: number | null) {
  if (conf == null) return '—';
  return `${Math.round(conf * 100)}%`;
}

function confClass(conf: number | null) {
  if (conf == null) return 'text-gray-400';
  if (conf >= 0.8) return 'text-green-700';
  if (conf >= 0.6) return 'text-yellow-700';
  return 'text-red-700';
}

export function TakeoffRunSeamlessClient({ bidId, runId }: { bidId: string; runId: string }) {
  const { addToast } = useToast();

  const containerRef = useRef<HTMLDivElement | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);

  useEffect(() => {
    const onFs = () => {
      const fs = !!document.fullscreenElement;
      setIsFullscreen(fs);
    };
    document.addEventListener('fullscreenchange', onFs);
    onFs();
    return () => document.removeEventListener('fullscreenchange', onFs);
  }, []);

  async function toggleFullscreen() {
    try {
      if (!document.fullscreenElement) {
        await containerRef.current?.requestFullscreen();
      } else {
        await document.exitFullscreen();
      }
    } catch {
      // ignore
    }
  }

  const [items, setItems] = useState<TakeoffItem[]>([]);
  const [loadingItems, setLoadingItems] = useState(true);
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);

  const [evidence, setEvidence] = useState<EvidenceRow[]>([]);
  const [loadingEvidence, setLoadingEvidence] = useState(false);
  const [selectedEvidenceId, setSelectedEvidenceId] = useState<string | null>(null);

  const [filter, setFilter] = useState('');
  const [drawerOpen, setDrawerOpen] = useState(true);
  const [sourcesOpen, setSourcesOpen] = useState(true);

  const [escalating, setEscalating] = useState(false);

  type CoverageResponse = {
    flags?: { missingSchedule?: boolean; evidenceMiningMode?: boolean };
    items: { total: number; needsReview: number; noEvidence: number };
    index: { docsIndexed: number; sampledPages: number; maxScore: number };
    deep: { docsProcessed: number; pagesProcessed: number };
    topCandidates: Array<{ documentId: string; filename: string; score: number; bestPage: number; sampledPages: number }>;
  };

  const [coverage, setCoverage] = useState<CoverageResponse | null>(null);
  const [loadingCoverage, setLoadingCoverage] = useState(false);

  const selectedItem = useMemo(() => items.find((i) => i.id === selectedItemId) || null, [items, selectedItemId]);
  const selectedEvidence = useMemo(
    () => evidence.find((e) => e.finding.id === selectedEvidenceId) || null,
    [evidence, selectedEvidenceId]
  );

  // Current drawing target
  const [docId, setDocId] = useState<string | null>(null);
  const [page, setPage] = useState<number>(1);

  async function loadCoverage() {
    setLoadingCoverage(true);
    try {
      const res = await fetch(`/api/takeoff/runs/${runId}/coverage`, { cache: 'no-store' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || 'Failed to load coverage');
      setCoverage(data as CoverageResponse);
    } catch (err) {
      // coverage is helpful but non-fatal
      addToast({ type: 'error', message: err instanceof Error ? err.message : 'Failed to load coverage' });
    } finally {
      setLoadingCoverage(false);
    }
  }

  async function escalateSearch() {
    if (escalating) return;
    setEscalating(true);
    try {
      const res = await fetch(`/api/takeoff/runs/${runId}/escalate`, { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || 'Escalation failed');

      const newRunId = data?.runId as string | undefined;
      if (!newRunId) throw new Error('Could not start a deeper search. Please try again.');

      // Navigate to the new run
      window.location.href = `/projects/${bidId}/takeoff/${newRunId}`;
    } catch (err) {
      addToast({ type: 'error', message: err instanceof Error ? err.message : 'Escalation failed' });
    } finally {
      setEscalating(false);
    }
  }

  async function loadItems() { 
    setLoadingItems(true);
    try {
      const res = await fetch(`/api/takeoff/runs/${runId}/items`, { cache: 'no-store' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || 'Failed to load items');
      const list = (data.items || []) as TakeoffItem[];
      setItems(list);
      if (!selectedItemId && list[0]) {
        setSelectedItemId(list[0].id);
      }
    } catch (err) {
      addToast({ type: 'error', message: err instanceof Error ? err.message : 'Failed to load items' });
    } finally {
      setLoadingItems(false);
    }
  }

  async function loadEvidence(itemId: string) {
    setLoadingEvidence(true);
    setEvidence([]);
    setSelectedEvidenceId(null);
    try {
      const res = await fetch(`/api/takeoff/items/${itemId}/evidence`, { cache: 'no-store' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || 'Failed to load evidence');
      const ev = (data.evidence || []) as EvidenceRow[];
      setEvidence(ev);
      // auto-select best evidence: first row with pageNumber, else first row
      const best = ev.find((x) => x.finding.pageNumber != null) || ev[0] || null;
      if (best) {
        setSelectedEvidenceId(best.finding.id);
        jumpToFinding(best);
      }
    } catch (err) {
      addToast({ type: 'error', message: err instanceof Error ? err.message : 'Failed to load evidence' });
    } finally {
      setLoadingEvidence(false);
    }
  }

  function jumpToFinding(row: EvidenceRow) {
    const d = row.finding.documentId;
    const p = row.finding.pageNumber || (row.finding.evidence?.page as number | undefined) || 1;
    if (d) setDocId(d);
    setPage(p);
  }

  useEffect(() => {
    loadItems();
    loadCoverage();

    // If a run is opened immediately after starting a takeoff, it may be empty for a bit.
    // Poll briefly so the user doesn’t land on a “blank” workspace.
    let tries = 0;
    const t = setInterval(() => {
      tries += 1;
      if (tries > 40) {
        clearInterval(t);
        return;
      }
      // Only poll while the list is empty to avoid UI flicker.
      if (items.length === 0) {
        loadItems();
        loadCoverage();
      } else {
        clearInterval(t);
      }
    }, 4000);

    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId]);

  useEffect(() => {
    if (!selectedItemId) return;
    loadEvidence(selectedItemId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedItemId]);

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return items;
    return items.filter((it) => {
      const hay = `${it.code || ''} ${it.category} ${it.description} ${it.qtyText || ''}`.toLowerCase();
      return hay.includes(q);
    });
  }, [items, filter]);

  const highlightTerms = useMemo(() => {
    const terms: string[] = [];
    if (selectedItem?.code) terms.push(selectedItem.code);

    const t = (selectedEvidence?.finding.evidenceText || '').trim();
    if (t) {
      // pick a handful of meaningful tokens (avoid super-common words)
      const tokens = t
        .replace(/[^a-zA-Z0-9\s-]+/g, ' ')
        .split(/\s+/)
        .map((x) => x.trim())
        .filter((x) => x.length >= 4)
        .filter((x) => !/^(this|that|with|from|sheet|page|signs|sign|type|qty|each|provide|install)$/i.test(x));

      for (const tok of tokens.slice(0, 6)) {
        if (!terms.includes(tok)) terms.push(tok);
      }
    }

    return terms.slice(0, 8);
  }, [selectedItem?.code, selectedEvidence?.finding.evidenceText]);

  return (
    <div
      ref={containerRef}
      className={`relative h-full ${isFullscreen ? 'bg-background p-2' : ''}`}
    >
      {loadingItems && items.length === 0 && (
        <div className="absolute inset-0 z-30 flex items-center justify-center bg-background/80 backdrop-blur-sm">
          <div className="text-sm text-muted-foreground">Preparing takeoff review…</div>
        </div>
      )}

      {!loadingItems && items.length === 0 && (
        <div className="absolute inset-0 z-20 flex flex-col items-center justify-center bg-background/60 backdrop-blur-sm text-center p-6">
          <div className="text-sm font-medium">No items yet</div>
          <div className="text-xs text-muted-foreground mt-1 max-w-md">
            This takeoff is still starting up. If it stays empty after a minute, try Refresh.
          </div>
        </div>
      )}
      {/* Top bar */}
      <div className="flex items-center justify-between gap-3 mb-3">
        <div className="text-sm text-muted-foreground">
          <span className="font-medium text-foreground">Takeoff Review</span>
          <span className="ml-2 text-xs text-muted-foreground">(auto)</span>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" title={drawerOpen ? 'Hide items' : 'Show items'} onClick={() => setDrawerOpen((v) => !v)}>
            <span className="sr-only">{drawerOpen ? 'Hide items' : 'Show items'}</span>
            <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M4 4h16v16H4z" />
              <path d="M9 4v16" />
            </svg>
          </Button>
          <Button variant="outline" size="sm" title={sourcesOpen ? 'Hide sources' : 'Show sources'} onClick={() => setSourcesOpen((v) => !v)}>
            <span className="sr-only">{sourcesOpen ? 'Hide sources' : 'Show sources'}</span>
            <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M4 6h16" />
              <path d="M4 12h16" />
              <path d="M4 18h16" />
            </svg>
          </Button>
          <Button variant="outline" size="sm" title={isFullscreen ? 'Exit full screen' : 'Full screen'} onClick={toggleFullscreen}>
            <span className="sr-only">{isFullscreen ? 'Exit full screen' : 'Full screen'}</span>
            <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M8 3H5a2 2 0 0 0-2 2v3" />
              <path d="M16 3h3a2 2 0 0 1 2 2v3" />
              <path d="M8 21H5a2 2 0 0 1-2-2v-3" />
              <path d="M16 21h3a2 2 0 0 0 2-2v-3" />
            </svg>
          </Button>
          <Button variant="outline" size="sm" title="Refresh" onClick={() => { loadItems(); loadCoverage(); }} disabled={loadingItems || loadingCoverage}>
            <span className="sr-only">Refresh</span>
            <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 12a9 9 0 1 1-2.64-6.36" />
              <path d="M21 3v6h-6" />
            </svg>
          </Button>
          <Link className="underline text-sm" href={`/projects/${bidId}/takeoff`}>
            All takeoffs
          </Link>
        </div>
      </div>

      {/* Main drawing canvas */}
      <div className="relative border bg-white overflow-hidden h-full">
        {docId ? (
          <ProjectViewer
            documentId={docId}
            pageNumber={page}
            totalPages={1}
            items={[] as SignageItem[]}
            selectedItemId={null}
            onSelectItem={() => {}}
            quickAddMode={false}
            onQuickAddClick={() => {}}
            extractionStatus={undefined}
            highlightTerms={highlightTerms}
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-sm text-muted-foreground">
            Select an item to open drawings.
          </div>
        )}

        {/* Evidence rail overlay */}
        {sourcesOpen && (
          <div className="absolute left-0 right-0 bottom-0 p-3 bg-white/90 backdrop-blur border-t max-h-[35vh] overflow-auto">
          <div className="flex items-center justify-between gap-3 mb-2">
            <div className="text-sm">
              <span className="font-medium">{selectedItem ? selectedItem.description : 'No item selected'}</span>
              {selectedItem && (
                <span className="ml-2 text-xs text-muted-foreground">
                  {selectedItem.code ? `${selectedItem.code} · ` : ''}{selectedItem.category} · {selectedItem.qtyNumber ?? selectedItem.qtyText ?? '—'} {selectedItem.unit || ''}
                  {' · '}
                  <span className={confClass(selectedItem.confidence)}>{confLabel(selectedItem.confidence)}</span>
                </span>
              )}
            </div>
            <div className="text-xs text-muted-foreground">
              {loadingEvidence ? 'Loading sources…' : `${evidence.length} sources`}
            </div>
          </div>

          <div className="flex gap-2 overflow-auto pb-1">
            {evidence.length === 0 && !loadingEvidence && (
              <div className="text-sm text-muted-foreground">No sources yet (needs review).</div>
            )}
            {evidence.map((row) => {
              const ev = row.finding.evidence || {};
              const label = `${ev.filename || 'file'} p${row.finding.pageNumber ?? ev.page ?? '—'}${ev.sheetRef ? ` (${ev.sheetRef})` : ''}`;
              const active = row.finding.id === selectedEvidenceId;
              return (
                <button
                  key={row.finding.id}
                  className={`min-w-[240px] max-w-[360px] text-left border rounded px-2 py-1 text-xs hover:bg-gray-50 ${active ? 'bg-blue-50 border-blue-300' : 'bg-white'}`}
                  onClick={() => {
                    setSelectedEvidenceId(row.finding.id);
                    jumpToFinding(row);
                  }}
                  title={row.finding.evidenceText || ''}
                >
                  <div className="font-mono truncate">{label}</div>
                  <div className="truncate text-muted-foreground">{row.finding.type}{row.link.note ? ` · ${row.link.note}` : ''}</div>
                </button>
              );
            })}
          </div>

          {selectedEvidence && selectedEvidence.finding.evidenceText && (
            <div className="mt-2 text-xs text-muted-foreground line-clamp-2">
              {selectedEvidence.finding.evidenceText}
            </div>
          )}
        </div>
        )}

        {/* Items drawer (overlay) */}
        {drawerOpen && (
          <div className="absolute top-0 left-0 bottom-0 w-full md:w-[420px] max-w-[92vw] bg-white border-r shadow-lg flex flex-col">
            <div className="p-3 border-b flex items-center justify-between gap-2">
              <div>
                <div className="text-sm font-medium">Items</div>
                <div className="text-xs text-muted-foreground">{filtered.length} / {items.length}</div>
              </div>
              <Button variant="ghost" onClick={() => setDrawerOpen(false)}>Close</Button>
            </div>
            <div className="p-3 border-b space-y-2">
              {coverage && (
                <div className="rounded border bg-gray-50 p-2 text-xs">
                  {coverage.flags?.evidenceMiningMode ? (
                    <div className="mb-2 rounded border border-yellow-200 bg-yellow-50 px-2 py-1 text-[11px]">
                      <div className="font-medium">No schedule detected</div>
                      <div className="text-muted-foreground">
                        Extracted signage requirements from notes/callouts/specs (qty may be unspecified). Review required.
                      </div>
                    </div>
                  ) : null}
                  {coverage.flags?.missingSchedule && !coverage.flags?.evidenceMiningMode ? (
                    <div className="mb-2 rounded border border-yellow-200 bg-yellow-50 px-2 py-1 text-[11px]">
                      <div className="font-medium">No schedule/legend found</div>
                      <div className="text-muted-foreground">
                        Upload a signage schedule/legend/specs or use “Search more docs” to expand scope.
                      </div>
                    </div>
                  ) : null}
                  <div className="flex items-center justify-between gap-2">
                    <div className="font-medium">Completeness</div>
                    <div className="text-muted-foreground">
                      Indexed {coverage.index?.docsIndexed ?? 0} docs · Deep {coverage.deep?.docsProcessed ?? 0} docs
                    </div>
                  </div>
                  <div className="mt-1 grid grid-cols-3 gap-2">
                    <div>
                      <div className="text-muted-foreground">Items</div>
                      <div className="font-mono">{coverage.items?.total ?? 0}</div>
                    </div>
                    <div>
                      <div className="text-muted-foreground">Needs review</div>
                      <div className="font-mono">{coverage.items?.needsReview ?? 0}</div>
                    </div>
                    <div>
                      <div className="text-muted-foreground">No evidence</div>
                      <div className="font-mono">{coverage.items?.noEvidence ?? 0}</div>
                    </div>
                  </div>
                  {(coverage.items?.needsReview ?? 0) > 0 || (coverage.items?.noEvidence ?? 0) > 0 ? (
                    <div className="mt-2 flex items-center justify-between gap-2">
                      <div className="text-[11px] text-muted-foreground">
                        If “No evidence” is high, the takeoff may be missing schedules/legends or evidence linking.
                      </div>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={escalateSearch}
                        disabled={escalating}
                      >
                        {escalating ? 'Expanding…' : 'Search more docs'}
                      </Button>
                    </div>
                  ) : null}
                </div>
              )}

              {coverage?.topCandidates?.length ? (
                <div className="rounded border p-2">
                  <div className="text-xs font-medium mb-1">Best matching pages</div>
                  <div className="text-[11px] text-muted-foreground mb-1">Click to jump to likely schedules / legends / signage notes.</div>
                  <div className="flex gap-2 overflow-auto pb-1">
                    {coverage.topCandidates.slice(0, 8).map((c) => (
                      <button
                        key={c.documentId}
                        className="min-w-[240px] max-w-[320px] text-left border rounded px-2 py-1 text-xs hover:bg-gray-50"
                        onClick={() => {
                          setDocId(c.documentId);
                          setPage(c.bestPage || 1);
                          setDrawerOpen(false);
                        }}
                        title={c.filename}
                      >
                        <div className="font-mono truncate">{String(c.filename).split('/').slice(-1)[0]}</div>
                        <div className="truncate text-muted-foreground">score {c.score} · p{c.bestPage}</div>
                      </button>
                    ))}
                  </div>
                </div>
              ) : null}

              <Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter items…" />
            </div>
            <div className="flex-1 overflow-auto">
              {loadingItems && (
                <div className="p-4 text-sm text-muted-foreground">Loading…</div>
              )}
              {!loadingItems && filtered.length === 0 && (
                <div className="p-4 text-sm text-muted-foreground">No items.</div>
              )}
              {!loadingItems && filtered.map((it) => {
                const active = it.id === selectedItemId;
                return (
                  <button
                    key={it.id}
                    className={`w-full text-left px-3 py-2 border-b hover:bg-gray-50 ${active ? 'bg-blue-50' : ''}`}
                    onClick={() => {
                      setSelectedItemId(it.id);
                      setDrawerOpen(false);
                    }}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="font-medium text-sm leading-tight">
                        {it.code ? <span className="font-mono text-xs mr-2">{it.code}</span> : null}
                        {it.description}
                      </div>
                      <div className={`text-xs ${confClass(it.confidence)}`}>{confLabel(it.confidence)}</div>
                    </div>
                    <div className="text-xs text-muted-foreground mt-1">
                      {it.category} · {it.qtyNumber ?? it.qtyText ?? '—'} {it.unit || ''} · {it.status}
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </div>

      <div className="mt-2 text-xs text-muted-foreground">
        Tip: Select an item, then click a source to jump to the exact page.
      </div>
    </div>
  );
}
