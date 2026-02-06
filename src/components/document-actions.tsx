'use client';

import { useState } from 'react';

interface DocumentActionsProps {
  bidId: string;
  documentId: string;
  extractionStatus: string | null;
  hasStoragePath: boolean;
}

export function DocumentActions({
  bidId,
  documentId,
  extractionStatus,
  hasStoragePath,
}: DocumentActionsProps) {
  const [isStarting, setIsStarting] = useState(false);
  const [status, setStatus] = useState(extractionStatus);

  const statusLabel =
    status === 'completed'
      ? 'Ready'
      : status === 'extracting'
        ? 'Working…'
        : status === 'queued'
          ? 'Starting…'
          : status === 'failed'
            ? 'Needs attention'
            : 'Waiting';

  const handleStartTakeoff = async () => {
    setIsStarting(true);
    setStatus('queued');

    try {
      const response = await fetch('/api/takeoff/enqueue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bidId, documentIds: [documentId] }),
      });

      if (response.ok) {
        const data = await response.json().catch(() => ({}));
        setStatus(data.status || 'queued');
        // Refresh page after a delay to show updated status
        setTimeout(() => window.location.reload(), 1500);
      } else {
        setStatus('failed');
      }
    } catch {
      setStatus('failed');
    } finally {
      setIsStarting(false);
    }
  };

  return (
    <div className="flex items-center gap-2">
      {hasStoragePath && (
        <button
          onClick={handleStartTakeoff}
          disabled={isStarting}
          className="px-3 py-1 text-sm bg-blue-100 text-blue-700 rounded hover:bg-blue-200 disabled:opacity-50"
        >
          {isStarting ? 'Starting…' : 'Start takeoff'}
        </button>
      )}

      <span className="text-xs text-muted-foreground">{statusLabel}</span>

      {hasStoragePath && (
        <a
          href={`/api/documents/${documentId}/view`}
          target="_blank"
          rel="noopener noreferrer"
          className="px-3 py-1 text-sm bg-gray-100 text-gray-700 rounded hover:bg-gray-200"
        >
          Open PDF
        </a>
      )}
    </div>
  );
}
