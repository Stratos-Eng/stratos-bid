"use client"

import { useState, useCallback } from "react"
import { useRouter } from "next/navigation"
import { useDropzone } from "react-dropzone"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"

interface UploadState {
  status: "idle" | "uploading" | "processing" | "extracting" | "complete" | "error"
  progress: number
  currentFile: string
  error?: string
  projectId?: string
}

export default function NewProjectPage() {
  const router = useRouter()
  const [projectName, setProjectName] = useState("")
  const [files, setFiles] = useState<File[]>([])
  const [uploadState, setUploadState] = useState<UploadState>({
    status: "idle",
    progress: 0,
    currentFile: "",
  })

  const onDrop = useCallback((acceptedFiles: File[]) => {
    // Filter for PDFs only
    const pdfFiles = acceptedFiles.filter(
      (f) => f.type === "application/pdf" || f.name.toLowerCase().endsWith(".pdf")
    )
    setFiles((prev) => [...prev, ...pdfFiles])

    // Auto-set project name from first file if empty
    if (!projectName && pdfFiles.length > 0) {
      const name = pdfFiles[0].name.replace(/\.pdf$/i, "")
      setProjectName(name)
    }
  }, [projectName])

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

      // 2. Upload each file
      for (let i = 0; i < files.length; i++) {
        const file = files[i]
        setUploadState({
          status: "uploading",
          progress: Math.round(((i + 0.5) / files.length) * 50),
          currentFile: file.name,
          projectId,
        })

        // Chunked upload
        const chunkSize = 5 * 1024 * 1024 // 5MB
        const totalChunks = Math.ceil(file.size / chunkSize)

        // Init upload - only pass bidId, not projectId (which is the same value but would fail takeoffProjects validation)
        const initRes = await fetch("/api/upload/init", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            filename: file.name,
            fileSize: file.size,
            mimeType: "application/pdf",
            bidId,
            chunkSize,
          }),
        })

        if (!initRes.ok) throw new Error("Failed to initialize upload")
        const { uploadId } = await initRes.json()

        // Upload chunks
        for (let chunk = 0; chunk < totalChunks; chunk++) {
          const start = chunk * chunkSize
          const end = Math.min(start + chunkSize, file.size)
          const blob = file.slice(start, end)

          const chunkRes = await fetch(`/api/upload/chunk?uploadId=${uploadId}`, {
            method: "PUT",
            headers: {
              "Content-Type": "application/octet-stream",
              "Content-Range": `bytes ${start}-${end - 1}/${file.size}`,
            },
            body: blob,
          })

          if (!chunkRes.ok) throw new Error("Chunk upload failed")

          const fileProgress = (chunk + 1) / totalChunks
          const overallProgress = ((i + fileProgress) / files.length) * 50
          setUploadState((prev) => ({
            ...prev,
            progress: Math.round(overallProgress),
          }))
        }

        // Complete upload
        setUploadState((prev) => ({ ...prev, status: "processing" }))
        const completeRes = await fetch("/api/upload/complete", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ uploadId }),
        })

        if (!completeRes.ok) throw new Error("Failed to process file")
      }

      // 3. Trigger extraction
      setUploadState((prev) => ({
        ...prev,
        status: "extracting",
        progress: 75,
        currentFile: "Running AI extraction...",
      }))

      await fetch(`/api/projects/${projectId}/extract`, {
        method: "POST",
      })

      // 4. Complete
      setUploadState({
        status: "complete",
        progress: 100,
        currentFile: "",
        projectId,
      })

      // Redirect to project after short delay
      setTimeout(() => {
        router.push(`/projects/${projectId}`)
      }, 1000)
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
          {files.map((file, i) => (
            <div
              key={`${file.name}-${i}`}
              className="flex items-center justify-between bg-secondary/50 rounded px-3 py-2"
            >
              <span className="text-sm truncate flex-1">{file.name}</span>
              <span className="text-xs text-muted-foreground mx-2">
                {(file.size / 1024 / 1024).toFixed(1)} MB
              </span>
              {!isUploading && (
                <button
                  onClick={() => removeFile(i)}
                  className="text-muted-foreground hover:text-foreground"
                >
                  &times;
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Progress */}
      {uploadState.status !== "idle" && (
        <div className="mt-6">
          <div className="flex justify-between text-sm mb-2">
            <span>
              {uploadState.status === "uploading" && "Uploading..."}
              {uploadState.status === "processing" && "Processing PDF..."}
              {uploadState.status === "extracting" && "Extracting signage items..."}
              {uploadState.status === "complete" && "Complete!"}
              {uploadState.status === "error" && "Error"}
            </span>
            <span>{uploadState.progress}%</span>
          </div>
          <div className="h-2 bg-secondary rounded-full overflow-hidden">
            <div
              className={cn(
                "h-full transition-all duration-300",
                uploadState.status === "error" ? "bg-destructive" : "bg-primary"
              )}
              style={{ width: `${uploadState.progress}%` }}
            />
          </div>
          {uploadState.currentFile && (
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
