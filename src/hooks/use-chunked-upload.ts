'use client';

import { useState, useCallback, useRef } from 'react';

export interface UploadProgress {
  filename: string;
  fileSize: number;
  progress: number; // 0-100
  status: 'pending' | 'uploading' | 'assembling' | 'completed' | 'error' | 'paused';
  error?: string;
  uploadId?: string;
}

export interface ChunkedUploadOptions {
  projectId: string;
  onProgress?: (files: UploadProgress[]) => void;
  onFileComplete?: (result: { filename: string; sheets: string[] }) => void;
  onAllComplete?: (results: { filename: string; sheets: string[] }[]) => void;
  onError?: (filename: string, error: string) => void;
  chunkSize?: number; // Default 5MB
}

export interface FileToUpload {
  file: File;
  folderName?: string;
  relativePath?: string;
  projectId?: string; // Override projectId for this file
}

// Simple AbortController wrapper for cancellation
interface UploadController {
  abort: () => void;
  paused: boolean;
  aborted: boolean;
}

export function useChunkedUpload(options: ChunkedUploadOptions) {
  const {
    projectId,
    onProgress,
    onFileComplete,
    onAllComplete,
    onError,
    chunkSize = 5 * 1024 * 1024, // 5MB chunks - good balance for PDFs
  } = options;

  const [uploads, setUploads] = useState<UploadProgress[]>([]);
  const [isUploading, setIsUploading] = useState(false);
  const controllersRef = useRef<Map<string, UploadController>>(new Map());

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
    async (fileInfo: FileToUpload): Promise<{ filename: string; sheets: string[] }> => {
      const { file, folderName, relativePath, projectId: fileProjectId } = fileInfo;

      // Use per-file projectId if provided, otherwise use hook-level projectId
      const effectiveProjectId = fileProjectId || projectId;

      console.log('[upload] Starting upload for:', file.name, 'size:', file.size, 'projectId:', effectiveProjectId);

      // Create controller for this upload
      const controller: UploadController = {
        abort: () => { controller.aborted = true; },
        paused: false,
        aborted: false,
      };
      controllersRef.current.set(file.name, controller);

      // Initialize upload session
      const initRes = await fetch('/api/upload/init', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          filename: file.name,
          fileSize: file.size,
          mimeType: file.type || 'application/pdf',
          projectId: effectiveProjectId,
          chunkSize,
          folderName,
          relativePath,
        }),
      });

      if (!initRes.ok) {
        const err = await initRes.json();
        throw new Error(err.error || 'Failed to initialize upload');
      }

      const { uploadId, totalChunks } = await initRes.json();
      console.log('[upload] Init successful. uploadId:', uploadId, 'totalChunks:', totalChunks);

      updateUpload(file.name, { uploadId, status: 'uploading' });

      // Upload chunks using fetch
      const totalSize = file.size;
      let uploadedBytes = 0;

      for (let chunkIndex = 0; chunkIndex < totalChunks; chunkIndex++) {
        // Check if aborted
        if (controller.aborted) {
          throw new Error('Upload cancelled');
        }

        // Wait if paused
        while (controller.paused && !controller.aborted) {
          await new Promise(resolve => setTimeout(resolve, 100));
        }

        const start = chunkIndex * chunkSize;
        const end = Math.min(start + chunkSize, totalSize);
        const chunk = file.slice(start, end);

        console.log(`[upload] Uploading chunk ${chunkIndex + 1}/${totalChunks} (${start}-${end})`);

        const chunkRes = await fetch(`/api/upload/chunk?uploadId=${uploadId}`, {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/octet-stream',
            'Content-Range': `bytes ${start}-${end - 1}/${totalSize}`,
          },
          body: chunk,
        });

        if (!chunkRes.ok) {
          const err = await chunkRes.json().catch(() => ({ error: 'Chunk upload failed' }));
          throw new Error(err.error || `Failed to upload chunk ${chunkIndex + 1}`);
        }

        uploadedBytes = end;
        const progress = Math.round((uploadedBytes / totalSize) * 100);
        updateUpload(file.name, { progress, status: 'uploading' });
      }

      console.log('[upload] All chunks uploaded, completing...');
      updateUpload(file.name, { status: 'assembling', progress: 100 });

      // Complete the upload (assemble chunks + process PDF)
      const completeRes = await fetch('/api/upload/complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ uploadId }),
      });

      if (!completeRes.ok) {
        const err = await completeRes.json();
        throw new Error(err.error || 'Failed to process file');
      }

      const result = await completeRes.json();
      console.log('[upload] Upload complete:', result);
      updateUpload(file.name, { status: 'completed' });
      controllersRef.current.delete(file.name);
      onFileComplete?.({ filename: file.name, sheets: result.sheets });
      return { filename: file.name, sheets: result.sheets };
    },
    [projectId, chunkSize, updateUpload, onFileComplete]
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

      const results: { filename: string; sheets: string[] }[] = [];
      const errors: { filename: string; error: string }[] = [];

      // Upload files sequentially to avoid overwhelming the server
      for (const fileInfo of files) {
        try {
          const result = await uploadFile(fileInfo);
          results.push(result);
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : 'Unknown error';
          errors.push({
            filename: fileInfo.file.name,
            error: errorMessage,
          });
          onError?.(fileInfo.file.name, errorMessage);
          updateUpload(fileInfo.file.name, { status: 'error', error: errorMessage });
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

  const pause = useCallback(
    (filename: string) => {
      const controller = controllersRef.current.get(filename);
      if (controller) {
        controller.paused = true;
        updateUpload(filename, { status: 'paused' });
      }
    },
    [updateUpload]
  );

  const resume = useCallback(
    (filename: string) => {
      const controller = controllersRef.current.get(filename);
      if (controller) {
        controller.paused = false;
        updateUpload(filename, { status: 'uploading' });
      }
    },
    [updateUpload]
  );

  const cancel = useCallback((filename: string) => {
    const controller = controllersRef.current.get(filename);
    if (controller) {
      controller.abort();
      controllersRef.current.delete(filename);
      setUploads((prev) => prev.filter((u) => u.filename !== filename));
    }
  }, []);

  const pauseAll = useCallback(() => {
    controllersRef.current.forEach((controller, filename) => {
      controller.paused = true;
      updateUpload(filename, { status: 'paused' });
    });
  }, [updateUpload]);

  const resumeAll = useCallback(() => {
    controllersRef.current.forEach((controller, filename) => {
      controller.paused = false;
      updateUpload(filename, { status: 'uploading' });
    });
  }, [updateUpload]);

  const cancelAll = useCallback(() => {
    controllersRef.current.forEach((controller) => {
      controller.abort();
    });
    controllersRef.current.clear();
    setUploads([]);
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
    pause,
    resume,
    cancel,
    pauseAll,
    resumeAll,
    cancelAll,
    reset,
  };
}
