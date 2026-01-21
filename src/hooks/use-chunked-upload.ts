'use client';

import { useState, useCallback, useRef } from 'react';
import { upload } from '@vercel/blob/client';

export interface UploadProgress {
  filename: string;
  fileSize: number;
  progress: number; // 0-100
  status: 'pending' | 'uploading' | 'processing' | 'completed' | 'error' | 'cancelled';
  error?: string;
}

export interface UploadOptions {
  projectId?: string; // For takeoff flow
  bidId?: string; // For projects flow
  onProgress?: (files: UploadProgress[]) => void;
  onFileComplete?: (result: { filename: string; sheets?: string[]; documentId?: string }) => void;
  onAllComplete?: (results: { filename: string; sheets?: string[]; documentId?: string }[]) => void;
  onError?: (filename: string, error: string) => void;
}

export interface FileToUpload {
  file: File;
  folderName?: string;
  relativePath?: string;
  projectId?: string; // Override projectId for this file
  bidId?: string; // Override bidId for this file
}

export function useChunkedUpload(options: UploadOptions) {
  const {
    projectId,
    bidId,
    onProgress,
    onFileComplete,
    onAllComplete,
    onError,
  } = options;

  const [uploads, setUploads] = useState<UploadProgress[]>([]);
  const [isUploading, setIsUploading] = useState(false);
  const abortControllersRef = useRef<Map<string, AbortController>>(new Map());

  const updateUpload = useCallback(
    (filename: string, update: Partial<UploadProgress>) => {
      setUploads((prev) => {
        const next = prev.map((u) => (u.filename === filename ? { ...u, ...update } : u));
        onProgress?.(next);
        return next;
      });
    },
    [onProgress]
  );

  const uploadFile = useCallback(
    async (fileInfo: FileToUpload): Promise<{ filename: string; sheets?: string[]; documentId?: string }> => {
      const { file, folderName, relativePath, projectId: fileProjectId, bidId: fileBidId } = fileInfo;

      // Use per-file IDs if provided, otherwise use hook-level IDs
      const effectiveProjectId = fileProjectId || projectId;
      const effectiveBidId = fileBidId || bidId;

      if (!effectiveProjectId && !effectiveBidId) {
        throw new Error('Either projectId or bidId is required');
      }

      console.log('[upload] Starting upload for:', file.name, 'size:', file.size);

      // Create abort controller for this upload
      const abortController = new AbortController();
      abortControllersRef.current.set(file.name, abortController);

      try {
        // Determine storage path
        const timestamp = Date.now();
        const sanitizedFilename = file.name.replace(/[^a-zA-Z0-9.-]/g, '_');
        const storageFilename = `${timestamp}-${sanitizedFilename}`;

        let pathname: string;
        if (effectiveProjectId) {
          pathname = `takeoff/${effectiveProjectId}/${storageFilename}`;
        } else {
          pathname = `projects/${effectiveBidId}/${storageFilename}`;
        }

        updateUpload(file.name, { status: 'uploading', progress: 0 });

        // Upload directly to Vercel Blob
        const blob = await upload(pathname, file, {
          access: 'public',
          handleUploadUrl: '/api/upload/token',
          onUploadProgress: (event) => {
            const progress = Math.round((event.loaded / event.total) * 100);
            updateUpload(file.name, { progress, status: 'uploading' });
          },
        });

        console.log('[upload] Blob upload complete:', blob.url);

        // Check if cancelled during upload
        if (abortController.signal.aborted) {
          throw new Error('Upload cancelled');
        }

        updateUpload(file.name, { status: 'processing', progress: 100 });

        // Call complete-blob to process the uploaded file
        const completeRes = await fetch('/api/upload/complete-blob', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            blobUrl: blob.url,
            pathname: blob.pathname,
            filename: file.name,
            projectId: effectiveProjectId,
            bidId: effectiveBidId,
            folderName,
            relativePath,
          }),
          signal: abortController.signal,
        });

        if (!completeRes.ok) {
          const err = await completeRes.json();
          throw new Error(err.error || 'Failed to process file');
        }

        const result = await completeRes.json();
        console.log('[upload] Processing complete:', result);

        updateUpload(file.name, { status: 'completed' });
        abortControllersRef.current.delete(file.name);

        const uploadResult = {
          filename: file.name,
          sheets: result.sheets,
          documentId: result.documentId,
        };

        onFileComplete?.(uploadResult);
        return uploadResult;
      } catch (error) {
        abortControllersRef.current.delete(file.name);
        throw error;
      }
    },
    [projectId, bidId, updateUpload, onFileComplete]
  );

  const uploadFiles = useCallback(
    async (files: FileToUpload[]) => {
      console.log('[upload] uploadFiles called with', files.length, 'files');
      if (files.length === 0) return { results: [], errors: [] };

      setIsUploading(true);

      // Initialize progress state for all files
      setUploads(
        files.map((f) => ({
          filename: f.file.name,
          fileSize: f.file.size,
          progress: 0,
          status: 'pending' as const,
        }))
      );

      const results: { filename: string; sheets?: string[]; documentId?: string }[] = [];
      const errors: { filename: string; error: string }[] = [];

      // Upload files sequentially to avoid overwhelming the server
      for (const fileInfo of files) {
        try {
          const result = await uploadFile(fileInfo);
          results.push(result);
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : 'Unknown error';

          // Don't report cancelled uploads as errors
          if (errorMessage !== 'Upload cancelled') {
            errors.push({
              filename: fileInfo.file.name,
              error: errorMessage,
            });
            onError?.(fileInfo.file.name, errorMessage);
          }

          updateUpload(fileInfo.file.name, {
            status: errorMessage === 'Upload cancelled' ? 'cancelled' : 'error',
            error: errorMessage === 'Upload cancelled' ? undefined : errorMessage,
          });
        }
      }

      setIsUploading(false);

      if (results.length > 0) {
        onAllComplete?.(results);
      }

      return { results, errors };
    },
    [uploadFile, onAllComplete, onError, updateUpload]
  );

  const cancel = useCallback((filename: string) => {
    const controller = abortControllersRef.current.get(filename);
    if (controller) {
      controller.abort();
      abortControllersRef.current.delete(filename);
      updateUpload(filename, { status: 'cancelled' });
    }
  }, [updateUpload]);

  const cancelAll = useCallback(() => {
    abortControllersRef.current.forEach((controller) => {
      controller.abort();
    });
    abortControllersRef.current.clear();
    setUploads((prev) => prev.map((u) =>
      u.status === 'uploading' || u.status === 'pending'
        ? { ...u, status: 'cancelled' as const }
        : u
    ));
    setIsUploading(false);
  }, []);

  const reset = useCallback(() => {
    cancelAll();
    setUploads([]);
  }, [cancelAll]);

  return {
    uploads,
    isUploading,
    uploadFiles,
    cancel,
    cancelAll,
    reset,
  };
}

// Legacy export for backwards compatibility
export { useChunkedUpload as useBlobUpload };
