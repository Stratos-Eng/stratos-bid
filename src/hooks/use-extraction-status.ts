'use client';

import { useState, useEffect, useCallback, useRef } from 'react';

export type ExtractionStatus =
  | 'not_started'
  | 'queued'
  | 'extracting'
  | 'completed'
  | 'failed';

interface DocumentStatus {
  id: string;
  filename: string;
  extractionStatus: ExtractionStatus;
  thumbnailsGenerated: boolean;
}

interface ExtractionStatusResult {
  documents: DocumentStatus[];
  overallStatus: ExtractionStatus;
  isComplete: boolean;
  isProcessing: boolean;
  hasError: boolean;
  progress: {
    completed: number;
    total: number;
    percentage: number;
  };
  refetch: () => void;
}

interface UseExtractionStatusOptions {
  projectId: string | null;
  enabled?: boolean;
  pollIntervalMs?: number;
  onComplete?: () => void;
  onError?: (error: Error) => void;
}

/**
 * Hook to poll extraction status for a project's documents
 * Automatically stops polling when all extractions are complete
 */
export function useExtractionStatus({
  projectId,
  enabled = true,
  pollIntervalMs = 3000,
  onComplete,
  onError,
}: UseExtractionStatusOptions): ExtractionStatusResult {
  const [documents, setDocuments] = useState<DocumentStatus[]>([]);
  const [error, setError] = useState<Error | null>(null);
  const intervalRef = useRef<NodeJS.Timeout | null>(null);
  const hasCalledComplete = useRef(false);

  const fetchStatus = useCallback(async () => {
    if (!projectId || !enabled) return;

    try {
      const response = await fetch(`/api/projects/${projectId}`);
      if (!response.ok) {
        throw new Error('Failed to fetch project status');
      }

      const data = await response.json();
      const docs: DocumentStatus[] = data.documents || [];
      setDocuments(docs);
      setError(null);

      // Check if all complete
      const allComplete = docs.length > 0 && docs.every(
        (doc) => doc.extractionStatus === 'completed' || doc.extractionStatus === 'failed'
      );

      if (allComplete && !hasCalledComplete.current) {
        hasCalledComplete.current = true;
        onComplete?.();
      }
    } catch (err) {
      const error = err instanceof Error ? err : new Error('Unknown error');
      setError(error);
      onError?.(error);
    }
  }, [projectId, enabled, onComplete, onError]);

  // Start/stop polling
  useEffect(() => {
    if (!projectId || !enabled) {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
      return;
    }

    // Reset state when projectId changes
    hasCalledComplete.current = false;

    // Initial fetch
    fetchStatus();

    // Set up polling
    intervalRef.current = setInterval(fetchStatus, pollIntervalMs);

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [projectId, enabled, pollIntervalMs, fetchStatus]);

  // Calculate overall status
  const overallStatus = calculateOverallStatus(documents);
  const isComplete = overallStatus === 'completed';
  const isProcessing = overallStatus === 'queued' || overallStatus === 'extracting';
  const hasError = overallStatus === 'failed' || error !== null;

  // Calculate progress
  const completed = documents.filter(
    (doc) => doc.extractionStatus === 'completed' || doc.extractionStatus === 'failed'
  ).length;
  const total = documents.length;
  const percentage = total > 0 ? Math.round((completed / total) * 100) : 0;

  return {
    documents,
    overallStatus,
    isComplete,
    isProcessing,
    hasError,
    progress: {
      completed,
      total,
      percentage,
    },
    refetch: fetchStatus,
  };
}

function calculateOverallStatus(documents: DocumentStatus[]): ExtractionStatus {
  if (documents.length === 0) return 'not_started';

  const statuses = documents.map((doc) => doc.extractionStatus);

  // If any are extracting, overall is extracting
  if (statuses.some((s) => s === 'extracting')) return 'extracting';

  // If any are queued (and none extracting), overall is queued
  if (statuses.some((s) => s === 'queued')) return 'queued';

  // If all are failed, overall is failed
  if (statuses.every((s) => s === 'failed')) return 'failed';

  // If all are completed or failed, overall is completed
  if (statuses.every((s) => s === 'completed' || s === 'failed')) return 'completed';

  // If any are not_started, overall is not_started
  if (statuses.some((s) => s === 'not_started')) return 'not_started';

  return 'not_started';
}
