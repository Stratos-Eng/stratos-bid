"use client"

import { useState, useCallback } from "react"
import { useRouter } from "next/navigation"
import { useDropzone } from "react-dropzone"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"
import { useExtractionStatus } from "@/hooks/use-extraction-status"
import { useToast } from "@/components/ui/toast"
import { useChunkedUpload, type UploadProgress } from "@/hooks/use-chunked-upload"

const LARGE_FILE_THRESHOLD = 50 * 1024 * 1024 // 50MB - uses chunked upload above this
const MAX_FILE_SIZE = 500 * 1024 * 1024 // 500MB - hard limit for uploads

interface UploadState {
  status: "idle" | "uploading" | "processing" | "extracting" | "complete" | "error"
  progress: number
  currentFile: string
  error?: string
  projectId?: string
}

export default function NewProjectPage() {
  const router = useRouter()
  const { addToast } = useToast()
  const [projectName, setProjectName] = useState("")
  const [files, setFiles] = useState<File[]>([])
  const [uploadState, setUploadState] = useState<UploadState>({
    status: "idle",
    progress: 0,
    currentFile: "",
  })
  const [fileProgress, setFileProgress] = useState<UploadProgress[]>([])

  // Set up chunked upload hook (will be configured with bidId when project is created)
  const [currentBidId, setCurrentBidId] = useState<string | null>(null)
  const chunkedUpload = useChunkedUpload({
    bidId: currentBidId || undefined,
    onProgress: (progress) => {
      setFileProgress(progress)
      // Calculate overall progress (upload is 0-50%)
      const completed = progress.filter(p => p.status === 'completed' || p.status === 'processing').length
      const uploading = progress.find(p => p.status === 'uploading')
      const uploadingProgress = uploading ? uploading.progress / 100 : 0
      const overallProgress = ((completed + uploadingProgress) / progress.length) * 50
      setUploadState(prev => ({
        ...prev,
        progress: Math.round(overallProgress),
        currentFile: uploading?.filename || progress.find(p => p.status === 'processing')?.filename || "",
      }))
    },
    onError: (filename, error) => {
      addToast({
        type: 'error',
        message: `Failed to upload ${filename}: ${error}`
      })
    },
  })

  // Poll extraction status once we have a project
  const extractionStatus = useExtractionStatus({
    projectId: uploadState.status === "extracting" ? uploadState.projectId || null : null,
    enabled: uploadState.status === "extracting",
    onComplete: () => {
      setUploadState(prev => ({
        ...prev,
        status: "complete",
        progress: 100,
        currentFile: "",
      }))
      addToast({
        type: 'success',
        message: 'Extraction complete! Redirecting to project...'
      })
      setTimeout(() => {
        router.push(`/projects/${uploadState.projectId}`)
      }, 1500)
    },
    onError: (error) => {
      addToast({
        type: 'error',
        message: `Extraction error: ${error.message}`
      })
    },
  })

  const onDrop = useCallback((acceptedFiles: File[]) => {
    // Filter for PDFs only and validate file size
    const pdfFiles: File[] = []
    const rejectedFiles: string[] = []

    for (const f of acceptedFiles) {
      const isPdf = f.type === "application/pdf" || f.name.toLowerCase().endsWith(".pdf")
      if (!isPdf) continue

      if (f.size > MAX_FILE_SIZE) {
        rejectedFiles.push(`${f.name} (${(f.size / 1024 / 1024).toFixed(0)}MB)`)
      } else {
        pdfFiles.push(f)
      }
    }

    if (rejectedFiles.length > 0) {
      addToast({
        type: 'error',
        message: `File too large (max 500MB): ${rejectedFiles.join(', ')}`
      })
    }

    setFiles((prev) => [...prev, ...pdfFiles])

    // Auto-set project name from first file if empty
    if (!projectName && pdfFiles.length > 0) {
      const name = pdfFiles[0].name.replace(/\.pdf$/i, "")
      setProjectName(name)
    }
  }, [projectName, addToast])

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: { "application/pdf": [".pdf"] },
    multiple: true,
  })

  const removeFile = (index: number) => {
    setFiles((prev) => prev.filter((_, i) => i !== index))
  }

  const handleUpload = async () => {
    if (!projectName.trim() || files.length === 0) return

    setUploadState({ status: "uploading", progress: 0, currentFile: "" })

    try {
      // 1. Create project
      const createRes = await fetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: projectName }),
      })

      if (!createRes.ok) {
        throw new Error("Failed to create project")
      }

      const { projectId, bidId } = await createRes.json()
      setCurrentBidId(bidId)

      // Check if any files are large (need chunked upload)
      const hasLargeFiles = files.some(f => f.size > LARGE_FILE_THRESHOLD)
      if (hasLargeFiles) {
        addToast({
          type: 'info',
          message: 'Large files detected - using chunked upload for reliability'
        })
      }

      // 2. Upload files using chunked upload hook (handles large files automatically)
      const filesToUpload = files.map(file => ({
        file,
        bidId, // Pass bidId for each file since hook might not be updated yet
      }))

      const { results, errors } = await chunkedUpload.uploadFiles(filesToUpload)

      if (errors.length > 0 && results.length === 0) {
        throw new Error(`All uploads failed: ${errors.map(e => e.error).join(', ')}`)
      }

      if (errors.length > 0) {
        addToast({
          type: 'warning',
          message: `${errors.length} file(s) failed to upload, proceeding with ${results.length} successful uploads`
        })
      }

      // 3. Trigger V3 agentic extraction for all documents in one batch call
      setUploadState({
        status: "extracting",
        progress: 75,
        currentFile: "Running AI extraction...",
        projectId,
      })

      const documentIds = results
        .map((r) => r.documentId)
        .filter((id): id is string => !!id)

      if (documentIds.length > 0) {
        await fetch('/api/takeoff/enqueue', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ bidId: projectId, documentIds }),
        })
      }

      // Note: Don't set complete here - the useExtractionStatus hook
      // will poll for completion and trigger the redirect
    } catch (error) {
      setUploadState({
        status: "error",
        progress: 0,
        currentFile: "",
        error: error instanceof Error ? error.message : "Upload failed",
      })
    }
  }

  const isUploading = uploadState.status !== "idle" && uploadState.status !== "error"

  return (
    <div className="mx-auto max-w-2xl py-12">
      <h1 className="text-2xl font-bold mb-8">New Project</h1>

      {/* Project Name */}
      <div className="mb-6">
        <label className="block text-sm font-medium mb-2">Project Name</label>
        <Input
          value={projectName}
          onChange={(e) => setProjectName(e.target.value)}
          placeholder="Enter project name..."
          disabled={isUploading}
        />
      </div>

      {/* Drop Zone */}
      <div
        {...getRootProps()}
        className={cn(
          "border-2 border-dashed rounded-lg p-12 text-center cursor-pointer transition-colors",
          isDragActive ? "border-primary bg-primary/5" : "border-border hover:border-primary/50",
          isUploading && "pointer-events-none opacity-50"
        )}
      >
        <input {...getInputProps()} disabled={isUploading} />
        <div className="text-4xl mb-4">📄</div>
        {isDragActive ? (
          <p className="text-primary font-medium">Drop PDFs here...</p>
        ) : (
          <>
            <p className="font-medium mb-1">Drop PDF files here</p>
            <p className="text-sm text-muted-foreground">or click to browse</p>
          </>
        )}
      </div>

      {/* File List */}
      {files.length > 0 && (
        <div className="mt-6 space-y-2">
          <p className="text-sm font-medium">{files.length} file(s) selected</p>
          {files.map((file, i) => {
            const isLargeFile = file.size > LARGE_FILE_THRESHOLD
            const progress = fileProgress.find(p => p.filename === file.name)
            return (
              <div
                key={`${file.name}-${i}`}
                className="flex items-center justify-between bg-secondary/50 rounded px-3 py-2"
              >
                <span className="text-sm truncate flex-1">{file.name}</span>
                <div className="flex items-center gap-2">
                  {isLargeFile && (
                    <span className="text-xs bg-yellow-100 text-yellow-800 px-1.5 py-0.5 rounded">
                      Large
                    </span>
                  )}
                  <span className="text-xs text-muted-foreground">
                    {(file.size / 1024 / 1024).toFixed(1)} MB
                  </span>
                  {progress && progress.status === 'uploading' && (
                    <span className="text-xs text-primary">{progress.progress}%</span>
                  )}
                  {progress && progress.status === 'retrying' && (
                    <span className="text-xs text-yellow-600">Retrying...</span>
                  )}
                  {progress && progress.status === 'completed' && (
                    <span className="text-xs text-green-600">Done</span>
                  )}
                  {progress && progress.status === 'error' && (
                    <span className="text-xs text-red-600">Failed</span>
                  )}
                </div>
                {!isUploading && (
                  <button
                    onClick={() => removeFile(i)}
                    className="text-muted-foreground hover:text-foreground ml-2"
                  >
                    &times;
                  </button>
                )}
              </div>
            )
          })}
        </div>
      )}

      {/* Progress */}
      {uploadState.status !== "idle" && (
        <div className="mt-6">
          <div className="flex justify-between text-sm mb-2">
            <span>
              {uploadState.status === "uploading" && "Uploading..."}
              {uploadState.status === "processing" && "Processing PDF..."}
              {uploadState.status === "extracting" && (
                extractionStatus.isProcessing
                  ? `Extracting signage items... (${extractionStatus.progress.completed}/${extractionStatus.progress.total} docs)`
                  : "Starting extraction..."
              )}
              {uploadState.status === "complete" && "Complete!"}
              {uploadState.status === "error" && "Error"}
            </span>
            <span>
              {uploadState.status === "extracting" && extractionStatus.progress.total > 0
                ? `${extractionStatus.progress.percentage}%`
                : `${uploadState.progress}%`}
            </span>
          </div>
          <div className="h-2 bg-secondary rounded-full overflow-hidden">
            <div
              className={cn(
                "h-full transition-all duration-300",
                uploadState.status === "error" ? "bg-destructive" : "bg-primary"
              )}
              style={{
                width: `${
                  uploadState.status === "extracting" && extractionStatus.progress.total > 0
                    ? 75 + (extractionStatus.progress.percentage * 0.25)
                    : uploadState.progress
                }%`
              }}
            />
          </div>
          {uploadState.status === "extracting" && extractionStatus.documents.length > 0 && (
            <div className="mt-3 space-y-1">
              {extractionStatus.documents.map((doc) => (
                <div key={doc.id} className="flex items-center gap-2 text-xs">
                  <span className={cn(
                    "w-2 h-2 rounded-full",
                    doc.extractionStatus === "completed" && "bg-green-500",
                    doc.extractionStatus === "extracting" && "bg-blue-500 animate-pulse",
                    doc.extractionStatus === "queued" && "bg-yellow-500",
                    doc.extractionStatus === "failed" && "bg-red-500",
                    doc.extractionStatus === "not_started" && "bg-gray-400"
                  )} />
                  <span className="text-muted-foreground truncate flex-1">{doc.filename}</span>
                  <span className="text-muted-foreground capitalize">{doc.extractionStatus}</span>
                </div>
              ))}
            </div>
          )}
          {uploadState.currentFile && uploadState.status !== "extracting" && (
            <p className="text-xs text-muted-foreground mt-1">{uploadState.currentFile}</p>
          )}
          {uploadState.error && (
            <p className="text-xs text-destructive mt-1">{uploadState.error}</p>
          )}
        </div>
      )}

      {/* Actions */}
      <div className="mt-8 flex gap-4">
        <Button
          variant="outline"
          onClick={() => router.back()}
          disabled={isUploading}
        >
          Cancel
        </Button>
        <Button
          onClick={handleUpload}
          disabled={!projectName.trim() || files.length === 0 || isUploading}
          className="flex-1"
        >
          {isUploading ? "Processing..." : "Create Project & Extract"}
        </Button>
      </div>
    </div>
  )
}
