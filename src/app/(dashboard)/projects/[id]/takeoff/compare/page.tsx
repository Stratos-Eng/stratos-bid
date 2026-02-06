import Link from 'next/link';
import { TakeoffCompareClient } from '@/components/takeoff/takeoff-compare-client';

export default async function TakeoffComparePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ runA?: string; runB?: string }>;
}) {
  const { id: bidId } = await params;
  const { runA, runB } = await searchParams;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Compare Takeoff Runs</h1>
          <div className="text-sm text-muted-foreground">Bid: {bidId}</div>
        </div>
        <div className="flex gap-3">
          <Link className="underline" href={`/projects/${bidId}/takeoff`}>Back to runs</Link>
        </div>
      </div>

      <TakeoffCompareClient bidId={bidId} runA={runA || null} runB={runB || null} />
    </div>
  );
}
