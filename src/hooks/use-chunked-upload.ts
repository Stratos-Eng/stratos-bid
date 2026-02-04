'use client';

import { useState, useCallback, useRef } from 'react';

// Configuration for uploads
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1000;
const CONCURRENT_UPLOADS = 3;

export interface UploadProgress {
  filename: string;
  fileSize: number;
  progress: number; // 0-100
  status: 'pending' | 'uploading' | 'processing' | 'completed' | 'error' | 'cancelled' | 'retrying';
  error?: string;
  retryCount?: number;
}

export interface UploadOptions {
  bidId?: string;
  onProgress?: (files: UploadProgress[]) => void;
  onFileComplete?: (result: { filename: string; documentId?: string }) => void;
  onAllComplete?: (results: { filename: string; documentId?: string }[]) => void;
  onError?: (filename: string, error: string) => void;
}

export interface FileToUpload {
  file: File;
  folderName?: string;
  relativePath?: string;
  bidId?: string; // Override bidId for this file
}

export function useChunkedUpload(options: UploadOptions) {
  const {
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

  // Helper function to delay execution
  const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

  // Upload to DO Spaces via presigned URL with XHR for progress tracking
  const uploadToStorage = useCallback(
    (uploadUrl: string, file: File, filename: string): Promise<void> => {
      return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('PUT', uploadUrl);
        xhr.setRequestHeader('Content-Type', 'application/pdf');

        xhr.upload.onprogress = (event) => {
          if (event.lengthComputable) {
            const progress = Math.round((event.loaded / event.total) * 100);
            updateUpload(filename, { progress, status: 'uploading' });
          }
        };

        xhr.onload = () => {
          if (xhr.status >= 200 && xhr.status < 300) {
            resolve();
          } else {
            reject(new Error(`Upload failed with status ${xhr.status}`));
          }
        };

        xhr.onerror = () => reject(new Error('Failed to fetch'));
        xhr.ontimeout = () => reject(new Error('timeout'));

        xhr.send(file);
      });
    },
    [updateUpload]
  );

  // Upload with retry logic
  const uploadWithRetry = useCallback(
    async (
      file: File,
      effectiveBidId: string,
      filename: string,
      retryCount = 0
    ): Promise<{ url: string; pathname: string }> => {
      try {
        // Step 1: Get presigned URL from our API
        const presignRes = await fetch('/api/upload/presign', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ filename, bidId: effectiveBidId }),
        });

        if (!presignRes.ok) {
          const err = await presignRes.json();
          throw new Error(err.error || 'Failed to get upload URL');
        }

        const { uploadUrl, key, publicUrl } = await presignRes.json();

        // Step 2: PUT file directly to DO Spaces via presigned URL
        await uploadToStorage(uploadUrl, file, filename);

        return { url: publicUrl, pathname: key };
      } catch (error) {
        const isNetworkError =
          error instanceof Error &&
          (error.message.includes('network') ||
           error.message.includes('Failed to fetch') ||
           error.message.includes('ERR_FAILED') ||
           error.message.includes('timeout'));

        if (isNetworkError && retryCount < MAX_RETRIES) {
          const nextRetry = retryCount + 1;
          const delayMs = RETRY_DELAY_MS * Math.pow(2, retryCount); // Exponential backoff

          console.log(`[upload] Retry ${nextRetry}/${MAX_RETRIES} for ${filename} after ${delayMs}ms`);
          updateUpload(filename, {
            status: 'retrying',
            retryCount: nextRetry,
            error: `Retrying (${nextRetry}/${MAX_RETRIES})...`
          });

          await delay(delayMs);
          return uploadWithRetry(file, effectiveBidId, filename, nextRetry);
        }
        throw error;
      }
    },
    [updateUpload, uploadToStorage]
  );

  const uploadFile = useCallback(
    async (fileInfo: FileToUpload): Promise<{ filename: string; documentId?: string }> => {
      const { file, folderName, relativePath, bidId: fileBidId } = fileInfo;

      const effectiveBidId = fileBidId || bidId;

      if (!effectiveBidId) {
        throw new Error('bidId is required');
      }

      const fileSizeMB = (file.size / 1024 / 1024).toFixed(1);
      console.log(`[upload] Starting upload for: ${file.name} (${fileSizeMB}MB)`);

      // Create abort controller for this upload
      const abortController = new AbortController();
      abortControllersRef.current.set(file.name, abortController);

      try {
        updateUpload(file.name, { status: 'uploading', progress: 0 });

        // Upload via presigned URL
        const blob = await uploadWithRetry(file, effectiveBidId, file.name);

        console.log('[upload] Upload complete:', blob.url);

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
          documentId: result.documentId,
        };

        onFileComplete?.(uploadResult);
        return uploadResult;
      } catch (error) {
        abortControllersRef.current.delete(file.name);
        throw error;
      }
    },
    [bidId, updateUpload, onFileComplete, uploadWithRetry]
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

      const results: { filename: string; documentId?: string }[] = [];
      const errors: { filename: string; error: string }[] = [];

      // Upload files concurrently with limited parallelism
      let index = 0;

      async function worker() {
        while (index < files.length) {
          const current = index++;
          const fileInfo = files[current];
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
      }

      const workers = Array.from(
        { length: Math.min(CONCURRENT_UPLOADS, files.length) },
        () => worker()
      );
      await Promise.all(workers);

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
