'use client';

import { useState } from 'react';

interface DocumentActionsProps {
  documentId: string;
  extractionStatus: string | null;
  hasStoragePath: boolean;
}

export function DocumentActions({
  documentId,
  extractionStatus,
  hasStoragePath,
}: DocumentActionsProps) {
  const [isExtracting, setIsExtracting] = useState(false);
  const [status, setStatus] = useState(extractionStatus);

  const handleExtract = async () => {
    setIsExtracting(true);
    setStatus('queued');

    try {
      const response = await fetch('/api/extraction', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ documentId }),
      });

      if (response.ok) {
        const data = await response.json();
        setStatus(data.status || 'queued');
        // Refresh page after a delay to show updated status
        setTimeout(() => window.location.reload(), 2000);
      } else {
        const error = await response.json();
        console.error('Extraction failed:', error);
        setStatus('failed');
      }
    } catch (error) {
      console.error('Extraction error:', error);
      setStatus('failed');
    } finally {
      setIsExtracting(false);
    }
  };

  return (
    <div className="flex items-center gap-2">
      {status !== 'completed' && status !== 'extracting' && hasStoragePath && (
        <button
          onClick={handleExtract}
          disabled={isExtracting}
          className="px-3 py-1 text-sm bg-blue-100 text-blue-700 rounded hover:bg-blue-200 disabled:opacity-50"
        >
          {isExtracting ? 'Queuing...' : 'Extract'}
        </button>
      )}
      {status === 'extracting' && (
        <span className="px-3 py-1 text-sm text-blue-600">
          Extracting...
        </span>
      )}
      {hasStoragePath && (
        <a
          href={`/api/documents/${documentId}/view`}
          target="_blank"
          rel="noopener noreferrer"
          className="px-3 py-1 text-sm bg-gray-100 text-gray-700 rounded hover:bg-gray-200"
        >
          View PDF
        </a>
      )}
    </div>
  );
}
