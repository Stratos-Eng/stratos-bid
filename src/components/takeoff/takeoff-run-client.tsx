'use client';

import { useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
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
  status: 'draft' | 'needs_review' | 'approved' | 'rejected' | 'modified' | string;
  createdAt: string;
  updatedAt: string;
};

type EvidenceRow = {
  finding: {
    id: string;
    type: string;
    pageNumber: number | null;
    evidenceText: string | null;
    evidence: any;
    confidence: number | null;
    createdAt: string;
  };
  link: { id: string; weight: number | null; note: string | null; createdAt: string };
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

export function TakeoffRunClient({ bidId, runId }: { bidId: string; runId: string }) {
  const { addToast } = useToast();
  const [items, setItems] = useState<TakeoffItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [evidence, setEvidence] = useState<EvidenceRow[] | null>(null);
  const [evidenceLoading, setEvidenceLoading] = useState(false);

  const selected = useMemo(() => items.find((i) => i.id === selectedId) || null, [items, selectedId]);

  const [filter, setFilter] = useState('');

  async function loadItems() {
    setLoading(true);
    try {
      const res = await fetch(`/api/takeoff/runs/${runId}/items`, { cache: 'no-store' });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'Failed to load items');
      setItems(data.items || []);
    } catch (err) {
      addToast({ type: 'error', message: err instanceof Error ? err.message : 'Failed to load items' });
    } finally {
      setLoading(false);
    }
  }

  async function loadEvidence(itemId: string) {
    setEvidenceLoading(true);
    setEvidence(null);
    try {
      const res = await fetch(`/api/takeoff/items/${itemId}/evidence`, { cache: 'no-store' });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'Failed to load evidence');
      setEvidence(data.evidence || []);
    } catch (err) {
      addToast({ type: 'error', message: err instanceof Error ? err.message : 'Failed to load evidence' });
    } finally {
      setEvidenceLoading(false);
    }
  }

  useEffect(() => {
    loadItems();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId]);

  useEffect(() => {
    if (!selectedId) return;
    loadEvidence(selectedId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId]);

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return items;
    return items.filter((it) => {
      const hay = `${it.code || ''} ${it.category || ''} ${it.description || ''} ${it.qtyText || ''}`.toLowerCase();
      return hay.includes(q);
    });
  }, [items, filter]);

  async function saveEdit(patch: Partial<TakeoffItem>) {
    if (!selected) return;
    try {
      const res = await fetch(`/api/takeoff/items/${selected.id}/edit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || 'Update failed');
      addToast({ type: 'success', message: 'Saved' });
      await loadItems();
    } catch (err) {
      addToast({ type: 'error', message: err instanceof Error ? err.message : 'Update failed' });
    }
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[1fr_420px] gap-6">
      <div className="space-y-4">
        <div className="flex items-center justify-between gap-4">
          <div>
            <div className="text-sm text-muted-foreground">Run</div>
            <div className="font-mono text-xs break-all">{runId}</div>
          </div>
          <div className="flex items-center gap-2">
            <Input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter by code/desc/category…"
              className="w-[260px]"
            />
            <Button variant="outline" onClick={() => loadItems()} disabled={loading}>
              Refresh
            </Button>
          </div>
        </div>

        <div className="bg-white rounded-lg border overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b">
              <tr>
                <th className="px-3 py-3 text-left text-xs font-medium text-gray-500 uppercase">Code</th>
                <th className="px-3 py-3 text-left text-xs font-medium text-gray-500 uppercase">Category</th>
                <th className="px-3 py-3 text-left text-xs font-medium text-gray-500 uppercase">Description</th>
                <th className="px-3 py-3 text-left text-xs font-medium text-gray-500 uppercase">Qty</th>
                <th className="px-3 py-3 text-left text-xs font-medium text-gray-500 uppercase">Unit</th>
                <th className="px-3 py-3 text-left text-xs font-medium text-gray-500 uppercase">Conf</th>
                <th className="px-3 py-3 text-left text-xs font-medium text-gray-500 uppercase">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {loading && (
                <tr>
                  <td colSpan={7} className="px-3 py-6 text-center text-muted-foreground">
                    Loading…
                  </td>
                </tr>
              )}

              {!loading && filtered.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-3 py-6 text-center text-muted-foreground">
                    No items yet.
                  </td>
                </tr>
              )}

              {!loading &&
                filtered.map((it) => (
                  <tr
                    key={it.id}
                    className={`cursor-pointer hover:bg-gray-50 ${selectedId === it.id ? 'bg-blue-50' : ''}`}
                    onClick={() => setSelectedId(it.id)}
                  >
                    <td className="px-3 py-3 font-mono text-xs">{it.code || '—'}</td>
                    <td className="px-3 py-3">{it.category}</td>
                    <td className="px-3 py-3 max-w-[520px] truncate" title={it.description}>
                      {it.description}
                    </td>
                    <td className="px-3 py-3">{it.qtyNumber != null ? it.qtyNumber : it.qtyText || '—'}</td>
                    <td className="px-3 py-3">{it.unit || '—'}</td>
                    <td className={`px-3 py-3 ${confClass(it.confidence)}`}>{confLabel(it.confidence)}</td>
                    <td className="px-3 py-3">{it.status}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>

        <div className="text-xs text-muted-foreground">
          Bid: <span className="font-mono">{bidId}</span>
        </div>
      </div>

      <div className="bg-white rounded-lg border p-4 space-y-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="text-sm text-muted-foreground">Selected item</div>
            <div className="font-medium">{selected ? selected.description : '—'}</div>
            <div className="font-mono text-xs break-all text-muted-foreground">{selected?.id}</div>
          </div>
        </div>

        {!selected && (
          <div className="text-sm text-muted-foreground">Click an item to view evidence and edit.</div>
        )}

        {selected && (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <div className="text-xs text-muted-foreground">Code</div>
                <Input
                  defaultValue={selected.code || ''}
                  onBlur={(e) => saveEdit({ code: e.target.value || null } as any)}
                />
              </div>
              <div>
                <div className="text-xs text-muted-foreground">Unit</div>
                <Input
                  defaultValue={selected.unit || ''}
                  onBlur={(e) => saveEdit({ unit: e.target.value || null } as any)}
                />
              </div>
              <div className="col-span-2">
                <div className="text-xs text-muted-foreground">Category</div>
                <Input
                  defaultValue={selected.category || ''}
                  onBlur={(e) => saveEdit({ category: e.target.value } as any)}
                />
              </div>
              <div className="col-span-2">
                <div className="text-xs text-muted-foreground">Description</div>
                <Textarea
                  defaultValue={selected.description || ''}
                  onBlur={(e) => saveEdit({ description: e.target.value } as any)}
                />
              </div>
              <div>
                <div className="text-xs text-muted-foreground">Qty (number)</div>
                <Input
                  type="number"
                  defaultValue={selected.qtyNumber ?? ''}
                  onBlur={(e) => {
                    const v = e.target.value;
                    saveEdit({ qtyNumber: v === '' ? null : Number(v), qtyText: null } as any);
                  }}
                />
              </div>
              <div>
                <div className="text-xs text-muted-foreground">Qty (text)</div>
                <Input
                  defaultValue={selected.qtyText ?? ''}
                  onBlur={(e) => saveEdit({ qtyText: e.target.value || null, qtyNumber: null } as any)}
                />
              </div>
            </div>

            <div className="flex items-center gap-2">
              {(['draft', 'needs_review', 'approved', 'rejected', 'modified'] as const).map((s) => (
                <Button
                  key={s}
                  variant={selected.status === s ? 'primary' : 'outline'}
                  size="sm"
                  onClick={() => saveEdit({ status: s } as any)}
                >
                  {s}
                </Button>
              ))}
            </div>

            <div className="pt-2 border-t">
              <div className="text-sm font-medium mb-2">Evidence</div>
              {evidenceLoading && <div className="text-sm text-muted-foreground">Loading evidence…</div>}
              {!evidenceLoading && evidence && evidence.length === 0 && (
                <div className="text-sm text-muted-foreground">No evidence linked.</div>
              )}
              {!evidenceLoading && evidence && evidence.length > 0 && (
                <div className="space-y-2 max-h-[420px] overflow-auto">
                  {evidence.map((e) => {
                    const ev = e.finding.evidence || {};
                    const title = `${ev.filename || 'file'} p${e.finding.pageNumber ?? '—'}`;
                    return (
                      <div key={e.finding.id} className="border rounded p-2">
                        <div className="text-xs text-muted-foreground flex items-center justify-between">
                          <span className="font-mono">{title}</span>
                          <span>{e.finding.type}</span>
                        </div>
                        {ev.sheetRef && <div className="text-xs text-muted-foreground">Sheet: {ev.sheetRef}</div>}
                        <div className="text-sm mt-1 whitespace-pre-wrap">{e.finding.evidenceText || '—'}</div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
