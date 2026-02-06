'use client';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { UploadProgress } from '@/hooks/use-chunked-upload';

export function UploadQueue({
  uploads,
  isUploading,
  onCancelAll,
  onRetryFailed,
  onCancelOne,
}: {
  uploads: UploadProgress[];
  isUploading: boolean;
  onCancelAll: () => void;
  onRetryFailed: () => void;
  onCancelOne: (filename: string) => void;
}) {
  const counts = uploads.reduce(
    (acc, u) => {
      acc.total += 1;
      acc[u.status] = (acc as any)[u.status] + 1;
      return acc;
    },
    {
      total: 0,
      pending: 0,
      uploading: 0,
      processing: 0,
      completed: 0,
      error: 0,
      cancelled: 0,
      retrying: 0,
    } as any
  ) as Record<string, number>;

  const failed = uploads.filter((u) => u.status === 'error');

  return (
    <div className="mt-6 border rounded-lg bg-white overflow-hidden">
      <div className="p-3 border-b flex items-center justify-between gap-3">
        <div>
          <div className="text-sm font-medium">Upload queue</div>
          <div className="text-xs text-muted-foreground">
            {counts.completed}/{counts.total} done · {counts.uploading} uploading · {counts.retrying} retrying · {counts.error} failed
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={onRetryFailed} disabled={isUploading || failed.length === 0}>
            Retry failed ({failed.length})
          </Button>
          <Button variant="danger" size="sm" onClick={onCancelAll} disabled={!isUploading}>
            Cancel all
          </Button>
        </div>
      </div>

      <div className="max-h-[320px] overflow-auto">
        {uploads.map((u) => (
          <div key={u.filename} className="px-3 py-2 border-b last:border-b-0">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="text-sm truncate" title={u.filename}>
                  {u.filename}
                </div>
                <div className="text-xs text-muted-foreground">
                  {(u.fileSize / 1024 / 1024).toFixed(1)} MB · {u.status}
                  {u.retryCount ? ` · retry ${u.retryCount}` : ''}
                  {u.error ? ` · ${u.error}` : ''}
                </div>
              </div>

              <div className="flex items-center gap-2">
                <div className="w-28 h-2 bg-secondary rounded-full overflow-hidden">
                  <div
                    className={cn(
                      'h-full',
                      u.status === 'error' ? 'bg-destructive' : 'bg-primary'
                    )}
                    style={{ width: `${u.progress}%` }}
                  />
                </div>

                {(u.status === 'uploading' || u.status === 'pending' || u.status === 'retrying') && (
                  <Button variant="ghost" size="sm" onClick={() => onCancelOne(u.filename)}>
                    Cancel
                  </Button>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>

      <div className="p-3 border-t text-xs text-muted-foreground">
        Tip: you can keep working—takeoff review will start automatically when uploads finish.
      </div>
    </div>
  );
}
