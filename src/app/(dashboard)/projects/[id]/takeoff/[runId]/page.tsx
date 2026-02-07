import Link from 'next/link';
import { TakeoffRunSeamlessClient } from '@/components/takeoff/takeoff-run-seamless-client';

export default async function TakeoffRunPage({
  params,
}: {
  params: Promise<{ id: string; runId: string }>;
}) {
  const { id: bidId, runId } = await params;

  return (
    <div className="h-[calc(100vh-6rem)]">
      <div className="flex items-center justify-between mb-2">
        <div className="text-sm text-muted-foreground">Takeoff Review</div>
        <Link className="underline text-sm" href={`/projects/${bidId}`}>Back to project</Link>
      </div>
      <TakeoffRunSeamlessClient bidId={bidId} runId={runId} />
    </div>
  );
}
