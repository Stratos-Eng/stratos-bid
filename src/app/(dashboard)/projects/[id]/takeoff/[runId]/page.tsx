import Link from 'next/link';
import { TakeoffRunReviewQueueClient } from '@/components/takeoff/takeoff-run-review-queue-client';

export default async function TakeoffRunPage({
  params,
}: {
  params: Promise<{ id: string; runId: string }>;
}) {
  const { id: bidId, runId } = await params;

  return (
    <div className="h-[calc(100vh-5rem)] min-h-[520px] flex flex-col">
      <div className="flex items-center justify-between mb-2 shrink-0">
        <div className="text-sm text-muted-foreground">Takeoff Review</div>
        <Link className="underline text-sm" href={`/projects/${bidId}`}>Back to project</Link>
      </div>
      <div className="flex-1 min-h-0">
        <TakeoffRunReviewQueueClient bidId={bidId} runId={runId} />
      </div>
    </div>
  );
}
