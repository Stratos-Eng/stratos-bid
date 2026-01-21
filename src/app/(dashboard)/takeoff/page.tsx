'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { useChunkedUpload, type FileToUpload } from '@/hooks/use-chunked-upload';
import { UploadProgress } from '@/components/upload/upload-progress';

interface Project {
  id: string;
  name: string;
  status: string;
  createdAt: string;
}

interface FileWithPath extends File {
  relativePath?: string;
}

// Helper to recursively get files from a directory entry
async function getFilesFromEntry(entry: FileSystemEntry, path = ''): Promise<FileWithPath[]> {
  if (entry.isFile) {
    return new Promise((resolve) => {
      (entry as FileSystemFileEntry).file((file) => {
        const fileWithPath = file as FileWithPath;
        fileWithPath.relativePath = path + file.name;
        resolve([fileWithPath]);
      }, () => resolve([]));
    });
  } else if (entry.isDirectory) {
    const dirReader = (entry as FileSystemDirectoryEntry).createReader();
    const entries: FileSystemEntry[] = [];

    // Read all entries (readEntries may return partial results)
    const readAllEntries = (): Promise<FileSystemEntry[]> => {
      return new Promise((resolve) => {
        dirReader.readEntries(async (batch) => {
          if (batch.length === 0) {
            resolve(entries);
          } else {
            entries.push(...batch);
            resolve(await readAllEntries());
          }
        }, () => resolve(entries));
      });
    };

    const allEntries = await readAllEntries();
    const files: FileWithPath[] = [];

    for (const subEntry of allEntries) {
      const subFiles = await getFilesFromEntry(subEntry, path + entry.name + '/');
      files.push(...subFiles);
    }

    return files;
  }
  return [];
}

export default function TakeoffProjectsPage() {
  const router = useRouter();
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [isDragging, setIsDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [currentProjectId, setCurrentProjectId] = useState<string | null>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);

  // Upload hook - projectId is set when project is created
  const {
    uploads,
    isUploading,
    uploadFiles,
    cancel,
    cancelAll,
    reset,
  } = useChunkedUpload({
    projectId: currentProjectId || '',
    onAllComplete: (results) => {
      if (currentProjectId && results.length > 0) {
        router.push(`/takeoff/${currentProjectId}`);
      }
    },
    onError: (filename, errorMsg) => {
      console.error(`Upload failed for ${filename}:`, errorMsg);
    },
  });

  // Fetch projects on mount
  useEffect(() => {
    async function fetchProjects() {
      try {
        const res = await fetch('/api/takeoff/projects');
        if (res.ok) {
          const data = await res.json();
          setProjects(data.projects || []);
        }
      } catch (err) {
        console.error('Failed to fetch projects:', err);
      } finally {
        setLoading(false);
      }
    }
    fetchProjects();
  }, []);

  // Derive project name from folder structure or files
  const getProjectName = (files: FileWithPath[]): string => {
    // Check if files have folder paths
    const paths = files
      .map((f) => f.relativePath || f.name)
      .filter((p) => p.includes('/'));

    if (paths.length > 0) {
      // Use the top-level folder name
      const topFolder = paths[0].split('/')[0];
      return topFolder.replace(/[_-]/g, ' ');
    }

    // Fall back to first file name
    return files[0].name.replace('.pdf', '').replace(/[_-]/g, ' ');
  };

  // Group files by subfolder for meaningful sheet names
  const organizeFiles = (files: FileWithPath[]): Map<string, FileWithPath[]> => {
    const groups = new Map<string, FileWithPath[]>();

    for (const file of files) {
      const path = file.relativePath || file.name;
      const parts = path.split('/');

      // Use subfolder name as group (or "root" for top-level files)
      let groupName = 'Drawings';
      if (parts.length > 2) {
        // Has nested folders - use immediate parent folder
        groupName = parts[parts.length - 2];
      } else if (parts.length === 2) {
        // Direct child of root folder
        groupName = 'Drawings';
      }

      if (!groups.has(groupName)) {
        groups.set(groupName, []);
      }
      groups.get(groupName)!.push(file);
    }

    return groups;
  };

  // Handle file drop - create project and upload with chunking
  const handleFileDrop = useCallback(async (files: FileWithPath[]) => {
    // Filter for PDFs only
    const pdfFiles = files.filter(
      (f) => f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf')
    );

    if (pdfFiles.length === 0) {
      setError('No PDF files found. Please drop PDF files or a folder containing PDFs.');
      setTimeout(() => setError(null), 4000);
      return;
    }

    setError(null);

    try {
      // 1. Create project with derived name
      const projectName = getProjectName(pdfFiles);

      const projectRes = await fetch('/api/takeoff/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: projectName }),
      });

      if (!projectRes.ok) {
        throw new Error('Failed to create project');
      }

      const { project } = await projectRes.json();
      setCurrentProjectId(project.id);

      // 2. Organize files and prepare for chunked upload
      const organized = organizeFiles(pdfFiles);
      const filesToUpload: FileToUpload[] = [];

      for (const [groupName, groupFiles] of organized) {
        for (const file of groupFiles) {
          filesToUpload.push({
            file,
            folderName: groupName !== 'Drawings' ? groupName : undefined,
            relativePath: file.relativePath,
          });
        }
      }

      // 3. Start chunked uploads - the hook handles progress and completion
      await uploadFiles(filesToUpload);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed');
      reset();
    }
  }, [uploadFiles, reset]);

  // Drag and drop handlers
  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    // Only set false if we're leaving the container, not entering a child
    if (e.currentTarget === e.target) {
      setIsDragging(false);
    }
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);

    // Check if we have directory entries (folder drop)
    const items = e.dataTransfer.items;
    if (items && items.length > 0) {
      const allFiles: FileWithPath[] = [];

      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        const entry = item.webkitGetAsEntry?.();

        if (entry) {
          const files = await getFilesFromEntry(entry);
          allFiles.push(...files);
        } else if (item.kind === 'file') {
          const file = item.getAsFile();
          if (file) {
            allFiles.push(file as FileWithPath);
          }
        }
      }

      if (allFiles.length > 0) {
        handleFileDrop(allFiles);
        return;
      }
    }

    // Fallback: use dataTransfer.files
    const files = Array.from(e.dataTransfer.files) as FileWithPath[];
    handleFileDrop(files);
  };

  // Handle folder input change
  const handleFolderSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      const files = Array.from(e.target.files) as FileWithPath[];
      // webkitRelativePath gives us the folder structure
      files.forEach((file) => {
        const webkitFile = file as File & { webkitRelativePath?: string };
        if (webkitFile.webkitRelativePath) {
          file.relativePath = webkitFile.webkitRelativePath;
        }
      });
      handleFileDrop(files);
    }
  };

  // Handle single/multiple file input change
  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      const files = Array.from(e.target.files) as FileWithPath[];
      handleFileDrop(files);
    }
  };

  if (loading) {
    return (
      <div className="max-w-4xl mx-auto">
        <div className="flex items-center justify-center py-12">
          <div className="animate-spin w-8 h-8 border-4 border-primary border-t-transparent rounded-full" />
        </div>
      </div>
    );
  }

  return (
    <div
      className="max-w-4xl mx-auto relative"
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* Full-screen drop overlay */}
      {isDragging && (
        <div className="fixed inset-0 bg-primary/10 backdrop-blur-sm z-50 flex items-center justify-center">
          <div className="bg-card border-2 border-dashed border-primary rounded-xl p-12 text-center shadow-2xl">
            <div className="text-6xl mb-4">📁</div>
            <h2 className="text-2xl font-serif font-bold text-foreground mb-2">
              Drop PDFs or Folders
            </h2>
            <p className="text-muted-foreground">
              We&apos;ll organize your drawings and create a project
            </p>
          </div>
        </div>
      )}

      {/* Upload progress overlay */}
      {isUploading && uploads.length > 0 && (
        <UploadProgress
          uploads={uploads}
          onCancel={cancel}
          onCancelAll={cancelAll}
        />
      )}

      {/* Error toast */}
      {error && (
        <div className="fixed bottom-4 right-4 z-50 bg-destructive text-white px-4 py-3 rounded-lg shadow-lg animate-slide-up max-w-md">
          <div className="flex items-start gap-3">
            <span className="text-lg">⚠️</span>
            <div className="flex-1">
              <p className="font-medium">{error}</p>
            </div>
            <button
              onClick={() => setError(null)}
              className="text-white/70 hover:text-white"
            >
              ✕
            </button>
          </div>
        </div>
      )}

      {/* Header */}
      <div className="flex justify-between items-center mb-6">
        <h1 className="text-2xl font-serif font-bold text-foreground">Takeoff Projects</h1>
        <Link
          href="/takeoff/new"
          className="px-4 py-2 bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 btn-lift"
        >
          New Project
        </Link>
      </div>

      {/* Hidden inputs for file/folder selection */}
      <input
        id="file-input"
        type="file"
        accept=".pdf,application/pdf"
        multiple
        className="hidden"
        onChange={handleFileSelect}
      />
      <input
        ref={folderInputRef}
        id="folder-input"
        type="file"
        // @ts-expect-error webkitdirectory is not in React types
        webkitdirectory=""
        directory=""
        multiple
        className="hidden"
        onChange={handleFolderSelect}
      />

      {/* Projects list */}
      {projects.length === 0 ? (
        <div className="text-center py-16 bg-card rounded-xl border border-border card-hover">
          <div className="text-6xl mb-4">📐</div>
          <h2 className="text-xl font-serif font-bold text-foreground mb-2">No projects yet</h2>
          <p className="text-muted-foreground mb-6">
            Drop PDFs or an entire folder to get started
          </p>

          {/* Drop zone */}
          <div className="border-2 border-dashed border-border rounded-lg p-8 mx-auto max-w-lg hover:border-primary transition-smooth">
            <div className="flex flex-col sm:flex-row gap-3 justify-center mb-4">
              <button
                type="button"
                onClick={() => document.getElementById('file-input')?.click()}
                className="px-4 py-2 bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 btn-lift"
              >
                Select PDFs
              </button>
              <button
                type="button"
                onClick={() => folderInputRef.current?.click()}
                className="px-4 py-2 bg-secondary text-secondary-foreground border border-border rounded-lg hover:bg-secondary/80"
              >
                Select Folder
              </button>
            </div>
            <p className="text-muted-foreground text-sm">
              or drag files/folders anywhere on this page
            </p>
            <p className="text-xs text-muted-foreground/70 mt-2">
              Supports folders with multiple PDFs • Large files are automatically chunked
            </p>
          </div>

          <p className="text-sm text-muted-foreground mt-6">
            Or{' '}
            <Link href="/takeoff/new" className="text-primary hover:underline">
              create a project manually
            </Link>
          </p>
        </div>
      ) : (
        <>
          {/* Quick drop hint */}
          <div className="mb-4 p-3 bg-secondary/50 rounded-lg text-sm text-muted-foreground text-center">
            Tip: Drop a PDF anywhere to create a new project instantly
          </div>

          <div className="bg-card rounded-lg border border-border divide-y divide-border">
            {projects.map((project) => (
              <Link
                key={project.id}
                href={`/takeoff/${project.id}`}
                className="p-4 hover:bg-secondary transition-smooth block"
              >
                <div className="flex items-center justify-between">
                  <div>
                    <h3 className="font-medium text-foreground">{project.name}</h3>
                    <p className="text-sm text-muted-foreground mt-1">
                      Created {new Date(project.createdAt).toLocaleDateString()}
                    </p>
                  </div>
                  <span
                    className={`px-2 py-1 text-xs rounded-full ${
                      project.status === 'active'
                        ? 'bg-sage/20 text-sage'
                        : project.status === 'completed'
                          ? 'bg-primary/20 text-primary'
                          : 'bg-secondary text-muted-foreground'
                    }`}
                  >
                    {project.status}
                  </span>
                </div>
              </Link>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
