import Link from 'next/link';

export default async function TakeoffRunPage({
  params,
}: {
  params: Promise<{ id: string; runId: string }>;
}) {
  const { id, runId } = await params;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Takeoff Run</h1>
          <div className="text-sm text-muted-foreground">Bid: {id} · Run: {runId}</div>
        </div>
        <div className="flex gap-3">
          <Link className="underline" href={`/projects/${id}`}>Back to project</Link>
        </div>
      </div>

      <div className="rounded border p-4">
        <h2 className="font-medium mb-2">Items</h2>
        <p className="text-sm text-muted-foreground">
          API: <code>/api/takeoff/runs/{runId}/items</code>
        </p>
        <p className="text-sm text-muted-foreground">
          Next: build table + evidence panel (v2 model).
        </p>
      </div>

      <div className="rounded border p-4">
        <h2 className="font-medium mb-2">Findings</h2>
        <p className="text-sm text-muted-foreground">
          API: <code>/api/takeoff/runs/{runId}/findings</code>
        </p>
      </div>
    </div>
  );
}
