'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useToast } from '@/components/ui/toast';
import { ProjectViewer } from '@/components/projects/project-viewer';
import type { SignageItem } from '@/lib/stores/project-store';

type TakeoffInstance = {
  id: string;
  runId: string;
  bidId: string;
  userId: string;
  typeItemId: string | null;
  sourceKind: string;
  status: string;
  confidence: number | null;
  createdAt: string;
  updatedAt: string;
  typeCode: string | null;
  typeDescription: string | null;
  meta: any;
  evidenceDocId?: string | null;
  evidencePageNumber?: number | null;
};

type InstanceSummary = { total: number; needs_review: number; inferred: number; counted: number };

type InstanceEvidenceRow = {
  instanceId: string;
  documentId: string;
  pageNumber: number | null;
  evidenceText: string | null;
  evidence: any;
  weight: number | null;
  createdAt: string;
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

export function TakeoffRunReviewQueueClient({ bidId, runId }: { bidId: string; runId: string }) {
  const { addToast } = useToast();

  const containerRef = useRef<HTMLDivElement | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);

  useEffect(() => {
    const onFs = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', onFs);
    onFs();
    return () => document.removeEventListener('fullscreenchange', onFs);
  }, []);

  async function toggleFullscreen() {
    try {
      if (!document.fullscreenElement) await containerRef.current?.requestFullscreen();
      else await document.exitFullscreen();
    } catch {
      // ignore
    }
  }

  const [filter, setFilter] = useState('');
  const [drawerOpen, setDrawerOpen] = useState(true);
  const [sourcesOpen, setSourcesOpen] = useState(true);
  const [selectedTypeKey, setSelectedTypeKey] = useState<string | null>(null);

  const [instances, setInstances] = useState<TakeoffInstance[]>([]);
  const [summary, setSummary] = useState<InstanceSummary | null>(null);
  const [loadingInstances, setLoadingInstances] = useState(true);
  const [selectedInstanceId, setSelectedInstanceId] = useState<string | null>(null);

  const [instanceEvidence, setInstanceEvidence] = useState<InstanceEvidenceRow[]>([]);
  const [loadingEvidence, setLoadingEvidence] = useState(false);
  const [selectedEvidenceKey, setSelectedEvidenceKey] = useState<string | null>(null);

  const selectedInstance = useMemo(
    () => instances.find((i) => i.id === selectedInstanceId) || null,
    [instances, selectedInstanceId]
  );

  const selectedEvidence = useMemo(() => {
    if (!selectedEvidenceKey) return null;
    const [instanceId, ix] = selectedEvidenceKey.split(':');
    const idx = Number(ix);
    if (!instanceId || !Number.isFinite(idx)) return null;
    if (instanceId !== selectedInstanceId) return null;
    return instanceEvidence[idx] || null;
  }, [selectedEvidenceKey, selectedInstanceId, instanceEvidence]);

  // Current drawing target
  const [docId, setDocId] = useState<string | null>(null);
  const [page, setPage] = useState<number>(1);

  function jumpToEvidence(row: InstanceEvidenceRow) {
    const d = row.documentId;
    const p = row.pageNumber || (row.evidence?.page as number | undefined) || 1;
    if (d) setDocId(d);
    setPage(p);
  }

  async function loadInstances() {
    setLoadingInstances(true);
    try {
      const res = await fetch(`/api/takeoff/runs/${runId}/instances`, { cache: 'no-store' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || 'Failed to load placements');
      setSummary((data.summary || null) as InstanceSummary | null);
      const list = (data.instances || []) as TakeoffInstance[];
      setInstances(list);
      if (!selectedInstanceId && list[0]) setSelectedInstanceId(list[0].id);
    } catch (err) {
      addToast({ type: 'error', message: err instanceof Error ? err.message : 'Failed to load placements' });
    } finally {
      setLoadingInstances(false);
    }
  }

  async function loadEvidence(instanceId: string) {
    setLoadingEvidence(true);
    setInstanceEvidence([]);
    setSelectedEvidenceKey(null);
    try {
      const res = await fetch(`/api/takeoff/instances/${instanceId}/evidence`, { cache: 'no-store' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || 'Failed to load evidence');
      const ev = (data.evidence || []) as InstanceEvidenceRow[];
      setInstanceEvidence(ev);
      const bestIdx = ev.findIndex((x) => x.pageNumber != null);
      const idx = bestIdx >= 0 ? bestIdx : 0;
      if (ev[idx]) {
        setSelectedEvidenceKey(`${instanceId}:${idx}`);
        jumpToEvidence(ev[idx]);
      }
    } catch (err) {
      addToast({ type: 'error', message: err instanceof Error ? err.message : 'Failed to load evidence' });
    } finally {
      setLoadingEvidence(false);
    }
  }

  async function setInstanceStatus(instanceId: string, status: 'counted' | 'excluded' | 'needs_review') {
    try {
      // optimistic UI
      setInstances((prev) => prev.map((x) => (x.id === instanceId ? { ...x, status } : x)));
      const res = await fetch(`/api/takeoff/instances/${instanceId}/status`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || 'Failed to update status');
    } catch (err) {
      addToast({ type: 'error', message: err instanceof Error ? err.message : 'Failed to update status' });
    }
  }

  useEffect(() => {
    loadInstances();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId]);

  useEffect(() => {
    if (!selectedInstanceId) return;
    loadEvidence(selectedInstanceId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedInstanceId]);

  const typeGroups = useMemo(() => {
    const m = new Map<string, { key: string; code: string; desc: string; count: number; pages: Array<{ docId: string; page: number }> }>();
    for (const inst of instances) {
      const code = (inst.typeCode || '—').trim();
      const desc = (inst.typeDescription || '').trim();
      const key = `${code}||${desc}`;
      const g = m.get(key) || { key, code, desc, count: 0, pages: [] as Array<{ docId: string; page: number }> };
      g.count += 1;
      const d = inst.evidenceDocId;
      const p = inst.evidencePageNumber;
      if (d && p) g.pages.push({ docId: d, page: p });
      m.set(key, g);
    }

    const groups = Array.from(m.values());
    for (const g of groups) {
      // de-dupe pages
      const seen = new Set<string>();
      const out: Array<{ docId: string; page: number }> = [];
      for (const x of g.pages) {
        const k = `${x.docId}:${x.page}`;
        if (seen.has(k)) continue;
        seen.add(k);
        out.push(x);
      }
      out.sort((a, b) => (a.page - b.page));
      g.pages = out;
    }

    groups.sort((a, b) => b.count - a.count || a.code.localeCompare(b.code));
    return groups;
  }, [instances]);

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const base = selectedTypeKey ? instances.filter((it) => `${(it.typeCode || '—').trim()}||${(it.typeDescription || '').trim()}` === selectedTypeKey) : instances;
    if (!q) return base;
    return base.filter((it) => {
      const hay = `${it.typeCode || ''} ${it.typeDescription || ''} ${it.status} ${it.sourceKind}`.toLowerCase();
      return hay.includes(q);
    });
  }, [instances, filter, selectedTypeKey]);

  const highlightTerms = useMemo(() => {
    const terms: string[] = [];
    if (selectedInstance?.typeCode) terms.push(selectedInstance.typeCode);

    const t = (selectedEvidence?.evidenceText || '').trim();
    if (t) {
      const tokens = t
        .replace(/[^a-zA-Z0-9\s-]+/g, ' ')
        .split(/\s+/)
        .map((x) => x.trim())
        .filter((x) => x.length >= 4)
        .filter((x) => !/^(this|that|with|from|sheet|page|signs|sign|type|qty|each|provide|install)$/i.test(x));

      for (const tok of tokens.slice(0, 6)) if (!terms.includes(tok)) terms.push(tok);
    }

    return terms.slice(0, 8);
  }, [selectedInstance?.typeCode, selectedEvidence?.evidenceText]);

  return (
    <div ref={containerRef} className={`relative h-full ${isFullscreen ? 'bg-background p-2' : ''}`}>
      {/* Top bar */}
      <div className="flex items-center justify-between gap-3 mb-3">
        <div className="text-sm text-muted-foreground">
          <span className="font-medium text-foreground">Review Queue</span>
          <span className="ml-2 text-xs text-muted-foreground">Placements</span>
          {summary ? (
            <span className="ml-2 text-xs text-muted-foreground">
              total {summary.total} · needs review {summary.needs_review} · counted {summary.counted}
            </span>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" title={drawerOpen ? 'Hide queue' : 'Show queue'} onClick={() => setDrawerOpen((v) => !v)}>
            Queue
          </Button>
          <Button variant="outline" size="sm" title={sourcesOpen ? 'Hide sources' : 'Show sources'} onClick={() => setSourcesOpen((v) => !v)}>
            Sources
          </Button>
          <Button variant="outline" size="sm" title={isFullscreen ? 'Exit full screen' : 'Full screen'} onClick={toggleFullscreen}>
            Full screen
          </Button>
          <Button variant="outline" size="sm" title="Refresh" onClick={loadInstances} disabled={loadingInstances}>
            Refresh
          </Button>
          <Link className="underline text-sm" href={`/projects/${bidId}/takeoff`}>
            All takeoffs
          </Link>
        </div>
      </div>

      {/* Main drawing canvas */}
      <div className="relative border bg-white overflow-hidden h-[calc(100vh-10rem)] min-h-[520px]">
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
            Select a placement to open drawings.
          </div>
        )}

        {/* Evidence rail */}
        {sourcesOpen && (
          <div className="absolute left-0 right-0 bottom-0 p-3 bg-white/90 backdrop-blur border-t max-h-[35vh] overflow-auto">
            <div className="flex items-center justify-between gap-3 mb-2">
              <div className="text-sm">
                <span className="font-medium">
                  {selectedInstance ? `${selectedInstance.typeCode || '—'} ${selectedInstance.typeDescription || ''}`.trim() : 'No placement selected'}
                </span>
                {selectedInstance ? (
                  <span className="ml-2 text-xs text-muted-foreground">
                    {selectedInstance.status} · {selectedInstance.sourceKind} · <span className={confClass(selectedInstance.confidence)}>{confLabel(selectedInstance.confidence)}</span>
                  </span>
                ) : null}
              </div>
              <div className="text-xs text-muted-foreground">
                {loadingEvidence ? 'Loading sources…' : `${instanceEvidence.length} sources`}
              </div>
            </div>

            <div className="flex gap-2 overflow-auto pb-1">
              {instanceEvidence.length === 0 && !loadingEvidence && (
                <div className="text-sm text-muted-foreground">No sources yet (needs review).</div>
              )}

              {instanceEvidence.map((row, idx) => {
                const ev = row.evidence || {};
                const label = `${ev.filename || 'file'} p${row.pageNumber ?? ev.page ?? '—'}`;
                const key = `${row.instanceId}:${idx}`;
                const active = key === selectedEvidenceKey;
                return (
                  <button
                    key={key}
                    className={`min-w-[240px] max-w-[360px] text-left border rounded px-2 py-1 text-xs hover:bg-gray-50 ${active ? 'bg-blue-50 border-blue-300' : 'bg-white'}`}
                    onClick={() => {
                      setSelectedEvidenceKey(key);
                      jumpToEvidence(row);
                    }}
                    title={row.evidenceText || ''}
                  >
                    <div className="font-mono truncate">{label}</div>
                    <div className="truncate text-muted-foreground">{ev.code || ''}</div>
                  </button>
                );
              })}
            </div>

            {selectedEvidence && selectedEvidence.evidenceText && (
              <div className="mt-2 text-xs text-muted-foreground line-clamp-2">{selectedEvidence.evidenceText}</div>
            )}
          </div>
        )}

        {/* Queue drawer */}
        {drawerOpen && (
          <div className="absolute top-0 left-0 bottom-0 w-full md:w-[420px] max-w-[92vw] bg-white border-r shadow-lg flex flex-col">
            <div className="p-3 border-b flex items-center justify-between gap-2">
              <div>
                <div className="text-sm font-medium">Types</div>
                <div className="text-xs text-muted-foreground">{typeGroups.length} types · {summary?.total ?? instances.length} placements</div>
              </div>
              <Button variant="ghost" onClick={() => setDrawerOpen(false)}>Close</Button>
            </div>

            <div className="p-3 border-b space-y-2">
              <Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter types/placements…" />

              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant={selectedTypeKey ? 'outline' : 'default'} onClick={() => setSelectedTypeKey(null)}>
                  All types
                </Button>
                {selectedTypeKey ? (
                  <Button size="sm" variant="outline" onClick={() => {
                    const g = typeGroups.find((x) => x.key === selectedTypeKey);
                    const first = g?.pages?.[0];
                    if (first) { setDocId(first.docId); setPage(first.page); }
                  }}>
                    Jump to first page
                  </Button>
                ) : null}

                {selectedInstanceId ? (
                  <>
                    <Button size="sm" onClick={() => setInstanceStatus(selectedInstanceId, 'counted')}>Accept</Button>
                    <Button size="sm" variant="outline" onClick={() => setInstanceStatus(selectedInstanceId, 'needs_review')}>Flag</Button>
                    <Button size="sm" variant="destructive" onClick={() => setInstanceStatus(selectedInstanceId, 'excluded')}>Reject</Button>
                  </>
                ) : null}
              </div>
            </div>

            <div className="flex-1 overflow-auto">
              {loadingInstances && (
                <div className="p-4 text-sm text-muted-foreground">Loading…</div>
              )}

              {!loadingInstances && typeGroups.map((g) => {
                const active = g.key === selectedTypeKey;
                return (
                  <button
                    key={g.key}
                    className={`w-full text-left px-3 py-2 border-b hover:bg-gray-50 ${active ? 'bg-blue-50' : ''}`}
                    onClick={() => {
                      setSelectedTypeKey(g.key);
                      // auto-jump to first page that contains this type if we have it
                      const first = g.pages?.[0];
                      if (first) { setDocId(first.docId); setPage(first.page); }
                    }}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="font-medium text-sm leading-tight">
                        <span className="font-mono text-xs mr-2">{g.code}</span>
                        {g.desc || 'Sign type'}
                      </div>
                      <div className="text-xs text-muted-foreground">{g.count}</div>
                    </div>
                    <div className="text-xs text-muted-foreground mt-1">
                      {g.pages.length ? `${g.pages.length} pages` : 'pages unknown (open evidence to navigate)'}
                    </div>
                  </button>
                );
              })}

              {/* Placements list (within selected type) */}
              {!loadingInstances && selectedTypeKey && (
                <div className="border-t">
                  <div className="px-3 py-2 text-xs text-muted-foreground">Placements in this type: {filtered.length}</div>
                  {filtered.map((it) => {
                    const active = it.id === selectedInstanceId;
                    return (
                      <button
                        key={it.id}
                        className={`w-full text-left px-3 py-2 border-b hover:bg-gray-50 ${active ? 'bg-blue-50' : ''}`}
                        onClick={() => {
                          setSelectedInstanceId(it.id);
                          setDrawerOpen(false);
                        }}
                      >
                        <div className="flex items-start justify-between gap-2">
                          <div className="text-sm leading-tight">
                            {it.status} · {it.sourceKind}
                          </div>
                          <div className={`text-xs ${confClass(it.confidence)}`}>{confLabel(it.confidence)}</div>
                        </div>
                        <div className="text-xs text-muted-foreground mt-1">
                          {it.evidencePageNumber ? `p${it.evidencePageNumber}` : ''}
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      <div className="mt-2 text-xs text-muted-foreground">
        Tip: review by clicking Accept/Reject and using Refresh as needed. Next pass will add hotkeys + bulk actions.
      </div>
    </div>
  );
}
