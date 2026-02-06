'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { useToast } from '@/components/ui/toast';

type CompareResult = {
  runA: string;
  runB: string;
  added: Array<{ itemKey: string; item: any }>;
  removed: Array<{ itemKey: string; item: any }>;
  changed: Array<{ itemKey: string; a: any; b: any; diff: Record<string, { a: any; b: any }> }>;
};

export function TakeoffCompareClient({
  bidId,
  runA,
  runB,
}: {
  bidId: string;
  runA: string | null;
  runB: string | null;
}) {
  const { addToast } = useToast();
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<CompareResult | null>(null);

  const canLoad = useMemo(() => Boolean(runA && runB), [runA, runB]);

  async function load() {
    if (!runA || !runB) return;
    setLoading(true);
    setResult(null);
    try {
      const res = await fetch(`/api/takeoff/runs/compare?runA=${encodeURIComponent(runA)}&runB=${encodeURIComponent(runB)}`, {
        cache: 'no-store',
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || 'Compare failed');
      setResult(data);
    } catch (err) {
      addToast({ type: 'error', message: err instanceof Error ? err.message : 'Compare failed' });
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (canLoad) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canLoad, runA, runB]);

  if (!runA || !runB) {
    return (
      <div className="text-sm text-muted-foreground">
        Pick two runs to compare from the <Link className="underline" href={`/projects/${bidId}/takeoff`}>runs list</Link>.
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="text-sm text-muted-foreground font-mono break-all">
          A: {runA} <br /> B: {runB}
        </div>
        <Button variant="outline" onClick={load} disabled={loading || !canLoad}>
          Refresh
        </Button>
      </div>

      {loading && <div className="text-sm text-muted-foreground">Comparing…</div>}

      {result && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          <div className="border rounded p-3 bg-white">
            <div className="text-sm font-medium">Added in B</div>
            <div className="text-2xl font-semibold">{result.added.length}</div>
          </div>
          <div className="border rounded p-3 bg-white">
            <div className="text-sm font-medium">Removed in B</div>
            <div className="text-2xl font-semibold">{result.removed.length}</div>
          </div>
          <div className="border rounded p-3 bg-white">
            <div className="text-sm font-medium">Changed</div>
            <div className="text-2xl font-semibold">{result.changed.length}</div>
          </div>
        </div>
      )}

      {result && (
        <div className="space-y-4">
          <DiffTable title="Added in B" rows={result.added.map((r) => ({ itemKey: r.itemKey, item: r.item }))} />
          <DiffTable title="Removed in B" rows={result.removed.map((r) => ({ itemKey: r.itemKey, item: r.item }))} />
          <ChangedTable title="Changed" rows={result.changed} />
        </div>
      )}
    </div>
  );
}

function DiffTable({ title, rows }: { title: string; rows: Array<{ itemKey: string; item: any }> }) {
  return (
    <div className="bg-white border rounded-lg overflow-hidden">
      <div className="px-3 py-2 border-b font-medium">{title} ({rows.length})</div>
      <table className="w-full text-sm">
        <thead className="bg-gray-50 border-b">
          <tr>
            <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase">Code</th>
            <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase">Category</th>
            <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase">Description</th>
            <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase">Qty</th>
            <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase">Unit</th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {rows.slice(0, 200).map((r) => (
            <tr key={r.itemKey}>
              <td className="px-3 py-2 font-mono text-xs">{r.item?.code || '—'}</td>
              <td className="px-3 py-2">{r.item?.category}</td>
              <td className="px-3 py-2">{r.item?.description}</td>
              <td className="px-3 py-2">{r.item?.qtyNumber ?? r.item?.qtyText ?? '—'}</td>
              <td className="px-3 py-2">{r.item?.unit || '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length > 200 && <div className="p-2 text-xs text-muted-foreground">Showing first 200…</div>}
    </div>
  );
}

function ChangedTable({
  title,
  rows,
}: {
  title: string;
  rows: Array<{ itemKey: string; a: any; b: any; diff: Record<string, { a: any; b: any }> }>;
}) {
  return (
    <div className="bg-white border rounded-lg overflow-hidden">
      <div className="px-3 py-2 border-b font-medium">{title} ({rows.length})</div>
      <table className="w-full text-sm">
        <thead className="bg-gray-50 border-b">
          <tr>
            <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase">Code</th>
            <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase">Description</th>
            <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase">Field</th>
            <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase">A</th>
            <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase">B</th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {rows.slice(0, 200).flatMap((r) =>
            Object.entries(r.diff).map(([field, v]) => (
              <tr key={`${r.itemKey}:${field}`}>
                <td className="px-3 py-2 font-mono text-xs">{r.a?.code || r.b?.code || '—'}</td>
                <td className="px-3 py-2">{r.a?.description || r.b?.description}</td>
                <td className="px-3 py-2 font-mono text-xs">{field}</td>
                <td className="px-3 py-2">{String(v.a ?? '')}</td>
                <td className="px-3 py-2">{String(v.b ?? '')}</td>
              </tr>
            ))
          )}
        </tbody>
      </table>
      {rows.length > 200 && <div className="p-2 text-xs text-muted-foreground">Showing first 200 items…</div>}
    </div>
  );
}
