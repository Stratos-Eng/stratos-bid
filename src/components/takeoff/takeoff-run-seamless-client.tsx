'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useToast } from '@/components/ui/toast';

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

  const [items, setItems] = useState<TakeoffItem[]>([]);
  const [loadingItems, setLoadingItems] = useState(true);
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);

  const [evidence, setEvidence] = useState<EvidenceRow[]>([]);
  const [loadingEvidence, setLoadingEvidence] = useState(false);
  const [selectedEvidenceId, setSelectedEvidenceId] = useState<string | null>(null);

  const [filter, setFilter] = useState('');
  const [drawerOpen, setDrawerOpen] = useState(true);

  const selectedItem = useMemo(() => items.find((i) => i.id === selectedItemId) || null, [items, selectedItemId]);
  const selectedEvidence = useMemo(
    () => evidence.find((e) => e.finding.id === selectedEvidenceId) || null,
    [evidence, selectedEvidenceId]
  );

  // Current drawing target
  const [docId, setDocId] = useState<string | null>(null);
  const [page, setPage] = useState<number>(1);

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

  const pdfSrc = useMemo(() => {
    if (!docId) return null;
    const safePage = Number.isFinite(page) && page > 0 ? page : 1;
    // Browser PDF viewers generally support #page=N
    return `/api/documents/${docId}/view#page=${safePage}`;
  }, [docId, page]);

  return (
    <div className="relative">
      {/* Top bar */}
      <div className="flex items-center justify-between gap-3 mb-3">
        <div className="text-sm text-muted-foreground">
          <span className="font-medium text-foreground">Takeoff review</span>{' '}
          <span className="font-mono text-xs">{runId}</span>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={() => setDrawerOpen((v) => !v)}>
            {drawerOpen ? 'Hide items' : 'Show items'}
          </Button>
          <Button variant="outline" onClick={loadItems} disabled={loadingItems}>
            Refresh
          </Button>
          <Link
            className="underline text-sm"
            href={`/projects/${bidId}/takeoff`}
          >
            Runs
          </Link>
        </div>
      </div>

      {/* Main drawing canvas */}
      <div className="relative rounded-lg border bg-white overflow-hidden" style={{ height: '78vh' }}>
        {pdfSrc ? (
          <iframe key={pdfSrc} src={pdfSrc} className="w-full h-full" />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-sm text-muted-foreground">
            Select an item to open drawings.
          </div>
        )}

        {/* Evidence rail overlay */}
        <div className="absolute left-0 right-0 bottom-0 p-3 bg-white/90 backdrop-blur border-t">
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
              {loadingEvidence ? 'Loading evidence…' : `${evidence.length} evidence`}
            </div>
          </div>

          <div className="flex gap-2 overflow-auto pb-1">
            {evidence.length === 0 && !loadingEvidence && (
              <div className="text-sm text-muted-foreground">No evidence linked.</div>
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

        {/* Items drawer (overlay) */}
        {drawerOpen && (
          <div className="absolute top-0 left-0 bottom-0 w-[420px] max-w-[92vw] bg-white border-r shadow-lg flex flex-col">
            <div className="p-3 border-b flex items-center justify-between gap-2">
              <div>
                <div className="text-sm font-medium">Items</div>
                <div className="text-xs text-muted-foreground">{filtered.length} / {items.length}</div>
              </div>
              <Button variant="ghost" onClick={() => setDrawerOpen(false)}>Close</Button>
            </div>
            <div className="p-3 border-b">
              <Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter…" />
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
        Tip: Select an item → click evidence chips to jump around the drawings. No tab switching.
      </div>
    </div>
  );
}
