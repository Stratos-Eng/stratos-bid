import Link from 'next/link';
import { TakeoffRunSeamlessClient } from '@/components/takeoff/takeoff-run-seamless-client';

export default async function TakeoffRunPage({
  params,
}: {
  params: Promise<{ id: string; runId: string }>;
}) {
  const { id: bidId, runId } = await params;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Takeoff</h1>
          <div className="text-sm text-muted-foreground">Bid: {bidId}</div>
        </div>
        <div className="flex gap-3">
          <Link className="underline" href={`/projects/${bidId}`}>Back to project</Link>
        </div>
      </div>

      <TakeoffRunSeamlessClient bidId={bidId} runId={runId} />
    </div>
  );
}
