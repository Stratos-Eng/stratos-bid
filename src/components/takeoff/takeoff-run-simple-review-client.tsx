'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
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

type Step = 'start' | 'review' | 'finish';

function confPct(conf: number | null) {
  if (conf == null) return '—';
  return `${Math.round(conf * 100)}%`;
}

function isRisky(i: TakeoffInstance) {
  const c = i.confidence ?? 0;
  if (i.status === 'needs_review') return true;
  if (c > 0 && c < 0.8) return true;
  if (!i.evidenceDocId || !i.evidencePageNumber) return true;
  return false;
}

export function TakeoffRunSimpleReviewClient({ bidId, runId }: { bidId: string; runId: string }) {
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

  const [step, setStep] = useState<Step>('start');

  const [instances, setInstances] = useState<TakeoffInstance[]>([]);
  const [summary, setSummary] = useState<InstanceSummary | null>(null);
  const [loadingInstances, setLoadingInstances] = useState(true);

  const [queue, setQueue] = useState<TakeoffInstance[]>([]);
  const [idx, setIdx] = useState(0);

  const current = queue[idx] || null;

  // Current drawing target
  const [docId, setDocId] = useState<string | null>(null);
  const [page, setPage] = useState<number>(1);

  const [instanceEvidence, setInstanceEvidence] = useState<InstanceEvidenceRow[]>([]);
  const [loadingEvidence, setLoadingEvidence] = useState(false);

  const [selectedEvidenceIx, setSelectedEvidenceIx] = useState<number>(0);
  const selectedEvidence = instanceEvidence[selectedEvidenceIx] || null;

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
    } catch (err) {
      addToast({ type: 'error', message: err instanceof Error ? err.message : 'Failed to load placements' });
    } finally {
      setLoadingInstances(false);
    }
  }

  async function loadEvidence(instanceId: string) {
    setLoadingEvidence(true);
    setInstanceEvidence([]);
    setSelectedEvidenceIx(0);
    try {
      const res = await fetch(`/api/takeoff/instances/${instanceId}/evidence`, { cache: 'no-store' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || 'Failed to load evidence');
      const ev = (data.evidence || []) as InstanceEvidenceRow[];
      setInstanceEvidence(ev);
      const bestIdx = ev.findIndex((x) => x.pageNumber != null);
      const nextIx = bestIdx >= 0 ? bestIdx : 0;
      setSelectedEvidenceIx(nextIx);
      if (ev[nextIx]) jumpToEvidence(ev[nextIx]);
      else if (current?.evidenceDocId && current.evidencePageNumber) {
        setDocId(current.evidenceDocId);
        setPage(current.evidencePageNumber);
      }
    } catch (err) {
      addToast({ type: 'error', message: err instanceof Error ? err.message : 'Failed to load evidence' });
    } finally {
      setLoadingEvidence(false);
    }
  }

  async function setInstanceStatus(instanceId: string, status: 'counted' | 'excluded' | 'needs_review') {
    try {
      // optimistic
      setInstances((prev) => prev.map((x) => (x.id === instanceId ? { ...x, status } : x)));
      setQueue((prev) => prev.map((x) => (x.id === instanceId ? { ...x, status } : x)));

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

  function next() {
    const nextIdx = idx + 1;
    if (nextIdx >= queue.length) {
      // move index to end so Finish screen math is sane
      setIdx(queue.length);
      setStep('finish');
      return;
    }
    setIdx(nextIdx);
  }

  function prev() {
    setIdx((v) => Math.max(0, v - 1));
  }

  // Build queue: risky first, then proof pack, then rest.
  const computedQueue = useMemo(() => {
    const list = instances.slice();
    const risky = list.filter(isRisky);
    const safe = list.filter((x) => !isRisky(x));

    // Proof pack: representative coverage across (doc,type) plus some medium-confidence.
    const proofSize = 40;
    const picked = new Set<string>();
    const proof: TakeoffInstance[] = [];

    // 1) coverage across doc+type
    for (const it of list) {
      if (proof.length >= proofSize) break;
      const key = `${it.evidenceDocId || '—'}||${(it.typeCode || '—').trim()}`;
      if (picked.has(key)) continue;
      picked.add(key);
      proof.push(it);
    }

    // de-dupe and preserve ordering buckets
    const seen = new Set<string>();
    const out: TakeoffInstance[] = [];
    for (const bucket of [risky, proof, safe]) {
      for (const it of bucket) {
        if (seen.has(it.id)) continue;
        seen.add(it.id);
        out.push(it);
      }
    }
    return out;
  }, [instances]);

  const riskyCount = useMemo(() => instances.filter(isRisky).length, [instances]);

  useEffect(() => {
    loadInstances();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId]);

  const queueKey = useMemo(() => computedQueue.map((x) => x.id).join(','), [computedQueue]);

  // When instances load, reset queue.
  useEffect(() => {
    setQueue(computedQueue);
    setIdx(0);
  }, [queueKey, computedQueue]);

  // When current changes, update viewer target + load evidence.
  useEffect(() => {
    if (!current) return;
    if (current.evidenceDocId) setDocId(current.evidenceDocId);
    if (current.evidencePageNumber) setPage(current.evidencePageNumber);
    loadEvidence(current.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.id]);

  // Basic hotkeys
  useEffect(() => {
    if (step !== 'review') return;
    const onKey = (e: KeyboardEvent) => {
      if (!current) return;
      if (e.target && (e.target as HTMLElement).tagName === 'INPUT') return;
      const k = e.key.toLowerCase();
      if (k === 'a') {
        e.preventDefault();
        setInstanceStatus(current.id, 'counted');
        next();
      } else if (k === 'r') {
        e.preventDefault();
        setInstanceStatus(current.id, 'excluded');
        next();
      } else if (k === 'f') {
        e.preventDefault();
        setInstanceStatus(current.id, 'needs_review');
        next();
      } else if (k === 'j') {
        e.preventDefault();
        next();
      } else if (k === 'k') {
        e.preventDefault();
        prev();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, current?.id, idx, queue.length]);

  if (loadingInstances) {
    return <div className="p-6 text-sm text-muted-foreground">Loading takeoff…</div>;
  }

  if (step === 'start') {
    const hasAny = instances.length > 0;

    return (
      <div className="p-6 space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-lg font-semibold">Takeoff Review</div>
            <div className="text-sm text-muted-foreground">
              {summary ? (
                <span>
                  total {summary.total} · counted {summary.counted} · needs review {summary.needs_review}
                </span>
              ) : (
                <span>{instances.length} placements</span>
              )}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Link className="underline text-sm" href={`/projects/${bidId}`}>Back to project</Link>
            <Button variant="outline" size="sm" onClick={loadInstances}>Refresh</Button>
          </div>
        </div>

        <div className="border rounded p-4 bg-white space-y-2">
          <div className="text-sm">
            The agent found <span className="font-medium">{instances.length}</span> placements across documents.
          </div>
          <div className="text-sm">
            Items that look risky (low confidence / missing evidence pointers / flagged):{' '}
            <span className="font-medium">{riskyCount}</span>
          </div>
          {!hasAny ? (
            <div className="text-sm text-muted-foreground">Nothing to review yet for this run.</div>
          ) : null}
        </div>

        <div className="flex items-center gap-2">
          <Button
            onClick={() => {
              if (!hasAny) {
                setStep('finish');
                return;
              }
              setStep('review');
              setQueue(computedQueue);
              setIdx(0);
            }}
            disabled={!hasAny}
          >
            Start review
          </Button>
          <Button variant="outline" onClick={() => { setStep('finish'); }}>Skip to finish</Button>
        </div>

        <div className="text-xs text-muted-foreground">
          Hotkeys during review: A accept · R reject · F flag · J next · K previous
        </div>
      </div>
    );
  }

  if (step === 'finish') {
    const remaining = queue.length - idx;
    const openFlags = instances.filter((x) => x.status === 'needs_review').length;

    return (
      <div className="p-6 space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-lg font-semibold">Finish</div>
            <div className="text-sm text-muted-foreground">Review status and export.</div>
          </div>
          <Link className="underline text-sm" href={`/projects/${bidId}`}>Back to project</Link>
        </div>

        <div className="border rounded p-4 bg-white space-y-2">
          <div className="text-sm">Remaining in this session: <span className="font-medium">{Math.max(0, remaining)}</span></div>
          <div className="text-sm">Flagged (needs review): <span className="font-medium">{openFlags}</span></div>
        </div>

        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={() => setStep('review')}>Back to review</Button>
          <a className="underline text-sm" href={`/api/takeoff/runs/${runId}/export`}>Export</a>
        </div>

        <div className="text-xs text-muted-foreground">
          Export is always available; flagged items are left as “needs review”.
        </div>
      </div>
    );
  }

  // review
  if (queue.length === 0) {
    // defensive: if something weird happens, don't show a broken 1/0 UI
    return (
      <div className="p-6 space-y-2">
        <div className="text-lg font-semibold">Review</div>
        <div className="text-sm text-muted-foreground">No placements to review.</div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => setStep('finish')}>Go to finish</Button>
          <Button variant="outline" onClick={loadInstances}>Refresh</Button>
        </div>
      </div>
    );
  }

  return (
    <div ref={containerRef} className={`relative h-full ${isFullscreen ? 'bg-background p-2' : ''}`}>
      <div className="flex items-center justify-between gap-3 mb-3">
        <div className="text-sm text-muted-foreground">
          <span className="font-medium text-foreground">Review</span>
          <span className="ml-2 text-xs text-muted-foreground">
            {idx + 1}/{queue.length}
          </span>
          {current ? (
            <span className="ml-2 text-xs text-muted-foreground">
              {(current.typeCode || '—').trim()} · {current.status} · {confPct(current.confidence)}
            </span>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={toggleFullscreen}>Full screen</Button>
          <Button variant="outline" size="sm" onClick={() => setStep('finish')}>Finish</Button>
          <Button variant="outline" size="sm" onClick={loadInstances}>Refresh</Button>
        </div>
      </div>

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
            highlightTerms={current?.typeCode ? [current.typeCode] : []}
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-sm text-muted-foreground">
            No document selected.
          </div>
        )}

        {/* bottom evidence + controls */}
        <div className="absolute left-0 right-0 bottom-0 p-3 bg-white/90 backdrop-blur border-t max-h-[38vh] overflow-auto">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="text-sm font-medium truncate">
                {current ? `${(current.typeCode || '—').trim()} ${current.typeDescription || ''}`.trim() : 'Done'}
              </div>
              <div className="text-xs text-muted-foreground">
                {loadingEvidence ? 'Loading sources…' : `${instanceEvidence.length} sources`}
              </div>
            </div>

            <div className="flex items-center gap-2 shrink-0">
              <Button size="sm" onClick={() => { if (!current) return; setInstanceStatus(current.id, 'counted'); next(); }}>Accept (A)</Button>
              <Button size="sm" variant="outline" onClick={() => { if (!current) return; setInstanceStatus(current.id, 'needs_review'); next(); }}>Flag (F)</Button>
              <Button size="sm" variant="destructive" onClick={() => { if (!current) return; setInstanceStatus(current.id, 'excluded'); next(); }}>Reject (R)</Button>
            </div>
          </div>

          <div className="mt-2 flex gap-2 overflow-auto pb-1">
            {instanceEvidence.map((row, i) => {
              const ev = row.evidence || {};
              const label = `${ev.filename || 'file'} p${row.pageNumber ?? ev.page ?? '—'}`;
              const active = i === selectedEvidenceIx;
              return (
                <button
                  key={`${row.instanceId}:${i}`}
                  className={`min-w-[240px] max-w-[360px] text-left border rounded px-2 py-1 text-xs hover:bg-gray-50 ${active ? 'bg-blue-50 border-blue-300' : 'bg-white'}`}
                  onClick={() => {
                    setSelectedEvidenceIx(i);
                    jumpToEvidence(row);
                  }}
                  title={row.evidenceText || ''}
                >
                  <div className="font-mono truncate">{label}</div>
                  <div className="truncate text-muted-foreground">{ev.code || ''}</div>
                </button>
              );
            })}

            {!loadingEvidence && instanceEvidence.length === 0 && (
              <div className="text-sm text-muted-foreground">No sources yet.</div>
            )}
          </div>

          {selectedEvidence?.evidenceText ? (
            <div className="mt-2 text-xs text-muted-foreground line-clamp-2">{selectedEvidence.evidenceText}</div>
          ) : null}

          <div className="mt-2 flex items-center justify-between">
            <div className="text-xs text-muted-foreground">J next · K previous</div>
            <div className="flex gap-2">
              <Button size="sm" variant="outline" onClick={prev} disabled={idx === 0}>Prev (K)</Button>
              <Button size="sm" variant="outline" onClick={next}>Next (J)</Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
