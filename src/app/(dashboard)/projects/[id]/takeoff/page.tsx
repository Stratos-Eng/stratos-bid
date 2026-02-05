import Link from 'next/link';
import { TakeoffRunsClient } from '@/components/takeoff/takeoff-runs-client';

export default async function TakeoffRunsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id: bidId } = await params;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Takeoff Runs</h1>
          <div className="text-sm text-muted-foreground">Bid: {bidId}</div>
        </div>
        <div className="flex gap-3">
          <Link className="underline" href={`/projects/${bidId}`}>Back to project</Link>
        </div>
      </div>

      <TakeoffRunsClient bidId={bidId} />
    </div>
  );
}
