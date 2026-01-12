'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

// Max file size: 50MB
const MAX_FILE_SIZE_MB = 50;
const MAX_FILE_SIZE_BYTES = MAX_FILE_SIZE_MB * 1024 * 1024;

export default function NewTakeoffProjectPage() {
  const router = useRouter();
  const [name, setName] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<string>('');
  const [warnings, setWarnings] = useState<string[]>([]);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) {
      const pdfFiles = Array.from(e.target.files).filter(
        (f) => f.type === 'application/pdf'
      );

      // Check file sizes
      const newWarnings: string[] = [];
      const validFiles: File[] = [];

      for (const file of pdfFiles) {
        if (file.size > MAX_FILE_SIZE_BYTES) {
          newWarnings.push(`"${file.name}" exceeds ${MAX_FILE_SIZE_MB}MB limit and was not added`);
        } else if (file.size > MAX_FILE_SIZE_BYTES * 0.8) {
          // Warn if close to limit
          newWarnings.push(`"${file.name}" is large (${(file.size / 1024 / 1024).toFixed(1)}MB) - upload may take a while`);
          validFiles.push(file);
        } else {
          validFiles.push(file);
        }
      }

      setWarnings(newWarnings);
      setFiles(validFiles);
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

    setUploading(true);
    setError(null);

    try {
      // 1. Create project
      setProgress('Creating project...');
      const projectRes = await fetch('/api/takeoff/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim() }),
      });

      if (!projectRes.ok) {
        throw new Error('Failed to create project');
      }

      const { project } = await projectRes.json();

      // 2. Upload each PDF and create sheets
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        setProgress(`Uploading ${file.name} (${i + 1}/${files.length})...`);

        const formData = new FormData();
        formData.append('file', file);
        formData.append('projectId', project.id);

        const uploadRes = await fetch('/api/takeoff/upload', {
          method: 'POST',
          body: formData,
        });

        if (!uploadRes.ok) {
          const err = await uploadRes.json();
          throw new Error(err.error || `Failed to upload ${file.name}`);
        }
      }

      // 3. Redirect to project
      setProgress('Redirecting...');
      router.push(`/takeoff/${project.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed');
      setUploading(false);
    }
  };

  return (
    <div className="max-w-2xl mx-auto">
      <h1 className="text-2xl font-serif font-bold text-foreground mb-6">New Takeoff Project</h1>

      <form onSubmit={handleSubmit} className="bg-card rounded-lg border border-border p-6 card-hover">
        {error && (
          <div className="mb-4 p-3 bg-destructive/10 border border-destructive/30 rounded-lg text-destructive text-sm">
            {error}
          </div>
        )}

        {warnings.length > 0 && (
          <div className="mb-4 p-3 bg-terracotta/10 border border-terracotta/30 rounded-lg text-terracotta text-sm">
            {warnings.map((warning, i) => (
              <p key={i}>{warning}</p>
            ))}
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
            disabled={uploading}
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
              disabled={uploading}
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
                Max {MAX_FILE_SIZE_MB}MB per file
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
                    {(file.size / 1024 / 1024).toFixed(2)} MB
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
            disabled={uploading}
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={uploading || !name.trim() || files.length === 0}
            className="px-6 py-2 bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed btn-lift"
          >
            {uploading ? progress : 'Create Project'}
          </button>
        </div>
      </form>
    </div>
  );
}
