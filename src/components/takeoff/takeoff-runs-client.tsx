'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { useToast } from '@/components/ui/toast';

type RunRow = {
  id: string;
  bidId: string;
  jobId: string;
  userId: string;
  status: string;
  model: string | null;
  workerId: string | null;
  startedAt: string;
  finishedAt: string | null;
  itemCount: number;
};

export function TakeoffRunsClient({ bidId }: { bidId: string }) {
  const { addToast } = useToast();
  const [runs, setRuns] = useState<RunRow[]>([]);
  const [loading, setLoading] = useState(true);

  const [publishedRunId, setPublishedRunId] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  async function load() {
    setLoading(true);
    try {
      const [runsRes, pubRes] = await Promise.all([
        fetch(`/api/takeoff/bids/${bidId}/runs`, { cache: 'no-store' }),
        fetch(`/api/takeoff/bids/${bidId}/publish`, { cache: 'no-store' }),
      ]);

      const runsData = await runsRes.json().catch(() => ({}));
      if (!runsRes.ok) throw new Error(runsData?.error || 'Failed to load runs');
      setRuns(runsData.runs || []);

      const pubData = await pubRes.json().catch(() => ({}));
      if (pubRes.ok) setPublishedRunId(pubData?.published?.runId || null);
    } catch (err) {
      addToast({ type: 'error', message: err instanceof Error ? err.message : 'Failed to load runs' });
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bidId]);

  const canCompare = selected.size === 2;
  const [runA, runB] = [...selected];

  async function publish(runId: string) {
    try {
      const res = await fetch(`/api/takeoff/bids/${bidId}/publish`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ runId }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || 'Publish failed');
      addToast({ type: 'success', message: 'Published' });
      setPublishedRunId(runId);
    } catch (err) {
      addToast({ type: 'error', message: err instanceof Error ? err.message : 'Publish failed' });
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div className="text-sm text-muted-foreground">Recent takeoffs</div>
        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={load} disabled={loading}>Refresh</Button>
          <Link
            className={`underline text-sm ${canCompare ? '' : 'pointer-events-none opacity-50'}`}
            href={canCompare ? `/projects/${bidId}/takeoff/compare?runA=${encodeURIComponent(runA)}&runB=${encodeURIComponent(runB)}` : '#'}
          >
            Compare (2)
          </Link>
          <Button variant="ghost" onClick={() => setSelected(new Set())} disabled={selected.size === 0}>
            Clear
          </Button>
        </div>
      </div>

      <div className="bg-white rounded-lg border overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 border-b">
            <tr>
              <th className="w-10 px-3 py-3"></th>
              <th className="px-3 py-3 text-left text-xs font-medium text-gray-500 uppercase">Started</th>
              <th className="px-3 py-3 text-left text-xs font-medium text-gray-500 uppercase">Status</th>
              <th className="px-3 py-3 text-left text-xs font-medium text-gray-500 uppercase">Items</th>
              <th className="px-3 py-3 text-left text-xs font-medium text-gray-500 uppercase">Type</th>
              <th className="px-3 py-3 text-left text-xs font-medium text-gray-500 uppercase">Open</th>
              <th className="px-3 py-3 text-left text-xs font-medium text-gray-500 uppercase">Publish</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {loading && (
              <tr><td colSpan={7} className="px-3 py-6 text-center text-muted-foreground">Loading…</td></tr>
            )}
            {!loading && runs.length === 0 && (
              <tr><td colSpan={7} className="px-3 py-6 text-center text-muted-foreground">No runs yet.</td></tr>
            )}
            {!loading && runs.map((r) => {
              const checked = selected.has(r.id);
              const isPublished = publishedRunId === r.id;
              return (
                <tr key={r.id}>
                  <td className="px-3 py-3">
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => {
                        const next = new Set(selected);
                        if (next.has(r.id)) next.delete(r.id);
                        else {
                          if (next.size >= 2) return;
                          next.add(r.id);
                        }
                        setSelected(next);
                      }}
                    />
                  </td>
                  <td className="px-3 py-3 whitespace-nowrap">{new Date(r.startedAt).toLocaleString()}</td>
                  <td className="px-3 py-3">{r.status}{isPublished ? ' (published)' : ''}</td>
                  <td className="px-3 py-3">{r.itemCount}</td>
                  <td className="px-3 py-3 text-xs text-muted-foreground">{r.itemCount > 0 ? 'Auto takeoff' : 'Review only'}</td>
                  <td className="px-3 py-3">
                    <Link className="underline" href={`/projects/${bidId}/takeoff/${r.id}`}>Open</Link>
                  </td>
                  <td className="px-3 py-3">
                    <Button
                      size="sm"
                      variant={isPublished ? 'secondary' : 'outline'}
                      onClick={() => publish(r.id)}
                    >
                      {isPublished ? 'Published' : 'Publish'}
                    </Button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="text-xs text-muted-foreground">
        Tip: open the most recent takeoff to start reviewing.
      </div>
    </div>
  );
}
