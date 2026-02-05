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

  async function load() {
    setLoading(true);
    try {
      const res = await fetch(`/api/takeoff/bids/${bidId}/runs`, { cache: 'no-store' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || 'Failed to load runs');
      setRuns(data.runs || []);
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

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="text-sm text-muted-foreground">Recent runs</div>
        <Button variant="outline" onClick={load} disabled={loading}>Refresh</Button>
      </div>

      <div className="bg-white rounded-lg border overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 border-b">
            <tr>
              <th className="px-3 py-3 text-left text-xs font-medium text-gray-500 uppercase">Started</th>
              <th className="px-3 py-3 text-left text-xs font-medium text-gray-500 uppercase">Status</th>
              <th className="px-3 py-3 text-left text-xs font-medium text-gray-500 uppercase">Items</th>
              <th className="px-3 py-3 text-left text-xs font-medium text-gray-500 uppercase">Model</th>
              <th className="px-3 py-3 text-left text-xs font-medium text-gray-500 uppercase">Open</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {loading && (
              <tr><td colSpan={5} className="px-3 py-6 text-center text-muted-foreground">Loading…</td></tr>
            )}
            {!loading && runs.length === 0 && (
              <tr><td colSpan={5} className="px-3 py-6 text-center text-muted-foreground">No runs yet.</td></tr>
            )}
            {!loading && runs.map((r) => (
              <tr key={r.id}>
                <td className="px-3 py-3 whitespace-nowrap">{new Date(r.startedAt).toLocaleString()}</td>
                <td className="px-3 py-3">{r.status}</td>
                <td className="px-3 py-3">{r.itemCount}</td>
                <td className="px-3 py-3 font-mono text-xs">{r.model || '—'}</td>
                <td className="px-3 py-3">
                  <Link className="underline" href={`/projects/${bidId}/takeoff/${r.id}`}>Open</Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="text-xs text-muted-foreground">
        Tip: once you enqueue a takeoff, refresh this page and open the latest run.
      </div>
    </div>
  );
}
