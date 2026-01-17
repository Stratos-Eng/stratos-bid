'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useChunkedUpload, type FileToUpload } from '@/hooks/use-chunked-upload';
import { UploadProgress } from '@/components/upload/upload-progress';

// Helper to format file size
function formatFileSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export default function NewTakeoffProjectPage() {
  const router = useRouter();
  const [name, setName] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [isCreatingProject, setIsCreatingProject] = useState(false);

  // Chunked upload hook
  const {
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
  } = useChunkedUpload({
    projectId: projectId || '',
    onAllComplete: (results) => {
      if (projectId && results.length > 0) {
        router.push(`/takeoff/${projectId}`);
      }
    },
    onError: (filename, errorMsg) => {
      console.error(`Upload failed for ${filename}:`, errorMsg);
    },
  });

  // Start uploads when projectId is set and we have files waiting
  const [pendingFiles, setPendingFiles] = useState<File[] | null>(null);

  useEffect(() => {
    console.log('[new-page] useEffect triggered. projectId:', projectId, 'pendingFiles:', pendingFiles?.length);
    if (projectId && pendingFiles && pendingFiles.length > 0) {
      console.log('[new-page] Starting upload for', pendingFiles.length, 'files');
      const filesToUpload: FileToUpload[] = pendingFiles.map((file) => ({
        file,
        projectId, // Pass projectId directly to avoid stale closure
      }));
      uploadFiles(filesToUpload);
      setPendingFiles(null);
    }
  }, [projectId, pendingFiles, uploadFiles]);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) {
      const pdfFiles = Array.from(e.target.files).filter(
        (f) => f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf')
      );
      setFiles(pdfFiles);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      setError('Project name is required');
      return;
    }
    if (files.length === 0) {
      setError('At least one PDF file is required');
      return;
    }

    setIsCreatingProject(true);
    setError(null);

    try {
      // 1. Create project
      const projectRes = await fetch('/api/takeoff/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim() }),
      });

      if (!projectRes.ok) {
        throw new Error('Failed to create project');
      }

      const { project } = await projectRes.json();

      // 2. Set project ID and pending files - the useEffect will trigger uploads
      setProjectId(project.id);
      setPendingFiles(files);
      setIsCreatingProject(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create project');
      setIsCreatingProject(false);
    }
  };

  const isBusy = isCreatingProject || isUploading;

  return (
    <div className="max-w-2xl mx-auto">
      <h1 className="text-2xl font-serif font-bold text-foreground mb-6">New Takeoff Project</h1>

      {/* Chunked upload progress overlay */}
      {isUploading && uploads.length > 0 && (
        <UploadProgress
          uploads={uploads}
          onPause={pause}
          onResume={resume}
          onCancel={cancel}
          onPauseAll={pauseAll}
          onResumeAll={resumeAll}
          onCancelAll={cancelAll}
        />
      )}

      <form onSubmit={handleSubmit} className="bg-card rounded-lg border border-border p-6 card-hover">
        {error && (
          <div className="mb-4 p-3 bg-destructive/10 border border-destructive/30 rounded-lg text-destructive text-sm">
            {error}
          </div>
        )}

        {/* Project Name */}
        <div className="mb-6">
          <label className="block text-sm font-medium text-foreground mb-2">
            Project Name
          </label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g., ABC Office Building"
            className="w-full px-4 py-2 border border-border rounded-lg focus:ring-2 focus:ring-primary focus:border-primary bg-input transition-smooth"
            disabled={isBusy}
          />
        </div>

        {/* PDF Upload */}
        <div className="mb-6">
          <label className="block text-sm font-medium text-foreground mb-2">
            PDF Plans
          </label>
          <div className="border-2 border-dashed border-border rounded-lg p-6 text-center hover:border-primary transition-smooth">
            <input
              type="file"
              accept=".pdf,application/pdf"
              multiple
              onChange={handleFileChange}
              className="hidden"
              id="pdf-upload"
              disabled={isBusy}
            />
            <label
              htmlFor="pdf-upload"
              className="cursor-pointer block"
            >
              <div className="text-4xl mb-2">📄</div>
              <p className="text-muted-foreground">
                Click to select PDF files or drag and drop
              </p>
              <p className="text-sm text-muted-foreground/70 mt-1">
                Each page becomes a sheet in your takeoff
              </p>
              <p className="text-xs text-muted-foreground/50 mt-1">
                Large files are automatically chunked for reliable uploads
              </p>
            </label>
          </div>

          {/* Selected files */}
          {files.length > 0 && (
            <div className="mt-4 space-y-2">
              {files.map((file, i) => (
                <div
                  key={i}
                  className="flex items-center justify-between p-2 bg-secondary rounded"
                >
                  <span className="text-sm text-foreground">{file.name}</span>
                  <span className="text-xs text-muted-foreground">
                    {formatFileSize(file.size)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Submit */}
        <div className="flex justify-end gap-3">
          <button
            type="button"
            onClick={() => router.back()}
            className="px-4 py-2 text-muted-foreground hover:bg-secondary rounded-lg transition-smooth"
            disabled={isBusy}
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={isBusy || !name.trim() || files.length === 0}
            className="px-6 py-2 bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed btn-lift"
          >
            {isCreatingProject ? 'Creating project...' : 'Create Project'}
          </button>
        </div>
      </form>
    </div>
  );
}
