'use client';

import { type UploadProgress as UploadProgressType } from '@/hooks/use-chunked-upload';

interface UploadProgressProps {
  uploads: UploadProgressType[];
  onPause?: (filename: string) => void;
  onResume?: (filename: string) => void;
  onCancel?: (filename: string) => void;
  onPauseAll?: () => void;
  onResumeAll?: () => void;
  onCancelAll?: () => void;
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function UploadProgress({
  uploads,
  onPause,
  onResume,
  onCancel,
  onPauseAll,
  onResumeAll,
  onCancelAll,
}: UploadProgressProps) {
  if (uploads.length === 0) return null;

  const completedCount = uploads.filter((u) => u.status === 'completed').length;
  const totalCount = uploads.length;
  const overallProgress = uploads.reduce((sum, u) => sum + u.progress, 0) / totalCount;
  const hasActive = uploads.some((u) => u.status === 'uploading' || u.status === 'assembling');
  const hasPaused = uploads.some((u) => u.status === 'paused');
  const hasErrors = uploads.some((u) => u.status === 'error');

  return (
    <div className="fixed inset-0 bg-charcoal/50 z-50 flex items-center justify-center p-4">
      <div className="bg-card rounded-xl p-6 shadow-2xl border border-border w-full max-w-lg max-h-[80vh] overflow-hidden flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-semibold text-foreground">
            Uploading Files ({completedCount}/{totalCount})
          </h3>
          <div className="flex gap-2">
            {hasActive && onPauseAll && (
              <button
                onClick={onPauseAll}
                className="px-3 py-1 text-sm bg-yellow-100 text-yellow-700 rounded hover:bg-yellow-200 transition-colors"
              >
                Pause All
              </button>
            )}
            {hasPaused && onResumeAll && (
              <button
                onClick={onResumeAll}
                className="px-3 py-1 text-sm bg-green-100 text-green-700 rounded hover:bg-green-200 transition-colors"
              >
                Resume All
              </button>
            )}
            {onCancelAll && (hasActive || hasPaused) && (
              <button
                onClick={onCancelAll}
                className="px-3 py-1 text-sm bg-red-100 text-red-700 rounded hover:bg-red-200 transition-colors"
              >
                Cancel All
              </button>
            )}
          </div>
        </div>

        {/* Overall progress */}
        <div className="mb-4">
          <div className="flex justify-between text-sm text-muted-foreground mb-1">
            <span>Overall Progress</span>
            <span>{Math.round(overallProgress)}%</span>
          </div>
          <div className="w-full bg-secondary rounded-full h-3">
            <div
              className={`h-3 rounded-full transition-all duration-300 ${
                hasErrors ? 'bg-destructive' : 'bg-primary'
              }`}
              style={{ width: `${overallProgress}%` }}
            />
          </div>
        </div>

        {/* File list */}
        <div className="flex-1 overflow-y-auto space-y-3 pr-1">
          {uploads.map((upload) => (
            <div
              key={upload.filename}
              className={`p-3 rounded-lg border transition-colors ${
                upload.status === 'error'
                  ? 'bg-destructive/10 border-destructive/30'
                  : upload.status === 'completed'
                    ? 'bg-sage/10 border-sage/30'
                    : upload.status === 'paused'
                      ? 'bg-yellow-50 border-yellow-200'
                      : 'bg-secondary/50 border-border'
              }`}
            >
              <div className="flex items-center justify-between mb-2">
                <div className="flex-1 min-w-0 mr-2">
                  <span className="text-sm font-medium text-foreground block truncate">
                    {upload.filename}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {formatFileSize(upload.fileSize)}
                  </span>
                </div>
                <div className="flex items-center gap-2 flex-shrink-0">
                  {/* Status badge */}
                  <span
                    className={`text-xs px-2 py-0.5 rounded-full whitespace-nowrap ${
                      upload.status === 'uploading'
                        ? 'bg-blue-100 text-blue-700'
                        : upload.status === 'assembling'
                          ? 'bg-purple-100 text-purple-700'
                          : upload.status === 'completed'
                            ? 'bg-green-100 text-green-700'
                            : upload.status === 'paused'
                              ? 'bg-yellow-100 text-yellow-700'
                              : upload.status === 'error'
                                ? 'bg-red-100 text-red-700'
                                : 'bg-gray-100 text-gray-700'
                    }`}
                  >
                    {upload.status === 'assembling'
                      ? 'Processing...'
                      : upload.status === 'uploading'
                        ? `${Math.round(upload.progress)}%`
                        : upload.status}
                  </span>

                  {/* Actions */}
                  {upload.status === 'uploading' && onPause && (
                    <button
                      onClick={() => onPause(upload.filename)}
                      className="w-6 h-6 flex items-center justify-center text-yellow-600 hover:bg-yellow-100 rounded transition-colors"
                      title="Pause"
                    >
                      <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
                        <path
                          fillRule="evenodd"
                          d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zM7 8a1 1 0 012 0v4a1 1 0 11-2 0V8zm5-1a1 1 0 00-1 1v4a1 1 0 102 0V8a1 1 0 00-1-1z"
                          clipRule="evenodd"
                        />
                      </svg>
                    </button>
                  )}
                  {upload.status === 'paused' && onResume && (
                    <button
                      onClick={() => onResume(upload.filename)}
                      className="w-6 h-6 flex items-center justify-center text-green-600 hover:bg-green-100 rounded transition-colors"
                      title="Resume"
                    >
                      <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
                        <path
                          fillRule="evenodd"
                          d="M10 18a8 8 0 100-16 8 8 0 000 16zM9.555 7.168A1 1 0 008 8v4a1 1 0 001.555.832l3-2a1 1 0 000-1.664l-3-2z"
                          clipRule="evenodd"
                        />
                      </svg>
                    </button>
                  )}
                  {(upload.status === 'uploading' || upload.status === 'paused') && onCancel && (
                    <button
                      onClick={() => onCancel(upload.filename)}
                      className="w-6 h-6 flex items-center justify-center text-red-600 hover:bg-red-100 rounded transition-colors"
                      title="Cancel"
                    >
                      <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
                        <path
                          fillRule="evenodd"
                          d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z"
                          clipRule="evenodd"
                        />
                      </svg>
                    </button>
                  )}
                </div>
              </div>

              {/* Progress bar */}
              {upload.status !== 'completed' && upload.status !== 'error' && (
                <div className="w-full bg-secondary rounded-full h-1.5">
                  <div
                    className={`h-1.5 rounded-full transition-all duration-300 ${
                      upload.status === 'paused'
                        ? 'bg-yellow-500'
                        : upload.status === 'assembling'
                          ? 'bg-purple-500'
                          : 'bg-primary'
                    }`}
                    style={{ width: `${upload.progress}%` }}
                  />
                </div>
              )}

              {/* Error message */}
              {upload.error && (
                <p className="text-xs text-destructive mt-2 break-words">{upload.error}</p>
              )}
            </div>
          ))}
        </div>

        {/* Completion message */}
        {completedCount === totalCount && totalCount > 0 && (
          <div className="mt-4 pt-4 border-t border-border text-center">
            <p className="text-sm text-sage font-medium">
              All files uploaded successfully!
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
