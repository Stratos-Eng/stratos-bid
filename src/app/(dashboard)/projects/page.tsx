"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import useSWR from "swr"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { useToast } from "@/components/ui/toast"

const fetcher = (url: string) => fetch(url).then((r) => r.json())

export default function ProjectsPage() {
  const router = useRouter()
  const { data, error, isLoading, mutate } = useSWR("/api/projects", fetcher)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [deleting, setDeleting] = useState(false)
  const { addToast } = useToast()

  const toggleSelect = (id: string, e: React.MouseEvent) => {
    e.stopPropagation()
    setSelectedIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) {
        next.delete(id)
      } else {
        next.add(id)
      }
      return next
    })
  }

  const selectAll = () => {
    const projects = data?.projects || []
    if (selectedIds.size === projects.length) {
      setSelectedIds(new Set())
    } else {
      setSelectedIds(new Set(projects.map((p: any) => p.id)))
    }
  }

  const handleBulkDelete = async () => {
    if (selectedIds.size === 0) return

    const confirmed = window.confirm(
      `Delete ${selectedIds.size} project${selectedIds.size > 1 ? "s" : ""}? This cannot be undone.`
    )
    if (!confirmed) return

    setDeleting(true)
    try {
      const res = await fetch("/api/projects", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: Array.from(selectedIds) }),
      })

      if (res.ok) {
        setSelectedIds(new Set())
        mutate()
        addToast({
          type: 'success',
          message: `Successfully deleted ${selectedIds.size} project${selectedIds.size > 1 ? 's' : ''}`
        })
      } else {
        const data = await res.json()
        addToast({
          type: 'error',
          message: data.error || "Failed to delete projects"
        })
      }
    } catch (err) {
      addToast({
        type: 'error',
        message: "Failed to delete projects"
      })
    } finally {
      setDeleting(false)
    }
  }

  if (isLoading) {
    return (
      <div className="flex justify-center py-12">
        <div className="text-muted-foreground">Loading projects...</div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex justify-center py-12">
        <div className="text-destructive">Failed to load projects</div>
      </div>
    )
  }

  const projects = data?.projects || []
  const allSelected = projects.length > 0 && selectedIds.size === projects.length

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold">Projects</h1>
        <div className="flex items-center gap-2">
          {selectedIds.size > 0 && (
            <Button
              variant="danger"
              onClick={handleBulkDelete}
              disabled={deleting}
            >
              {deleting ? "Deleting..." : `Delete (${selectedIds.size})`}
            </Button>
          )}
          <Button onClick={() => router.push("/projects/new")}>
            New Project
          </Button>
        </div>
      </div>

      {projects.length === 0 ? (
        <div className="text-center py-12 bg-muted/30 rounded-lg border border-dashed">
          <h3 className="text-lg font-medium mb-2">No projects yet</h3>
          <p className="text-muted-foreground mb-4">
            Upload bid documents to start a new signage takeoff project
          </p>
          <Button onClick={() => router.push("/projects/new")}>
            Create First Project
          </Button>
        </div>
      ) : (
        <div className="grid gap-4">
          {/* Select all header */}
          <div className="flex items-center gap-3 px-4 py-2 text-sm text-muted-foreground">
            <button
              onClick={selectAll}
              className={cn(
                "w-5 h-5 rounded border-2 flex items-center justify-center transition-colors",
                allSelected
                  ? "bg-primary border-primary text-primary-foreground"
                  : "border-muted-foreground/30 hover:border-muted-foreground"
              )}
            >
              {allSelected && (
                <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                </svg>
              )}
            </button>
            <span>Select all</span>
          </div>

          {projects.map((project: any) => {
            const isSelected = selectedIds.has(project.id)
            return (
              <div
                key={project.id}
                className={cn(
                  "flex items-center gap-3 p-4 bg-card rounded-lg border cursor-pointer transition-colors",
                  isSelected
                    ? "border-primary bg-primary/5"
                    : "hover:border-primary/50"
                )}
                onClick={() => router.push(`/projects/${project.id}`)}
              >
                {/* Checkbox */}
                <button
                  onClick={(e) => toggleSelect(project.id, e)}
                  className={cn(
                    "w-5 h-5 rounded border-2 flex items-center justify-center flex-shrink-0 transition-colors",
                    isSelected
                      ? "bg-primary border-primary text-primary-foreground"
                      : "border-muted-foreground/30 hover:border-primary"
                  )}
                >
                  {isSelected && (
                    <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                    </svg>
                  )}
                </button>

                <div className="flex-1 min-w-0">
                  <h3 className="font-medium truncate">{project.title}</h3>
                  <p className="text-sm text-muted-foreground">
                    {project.sourcePlatform === "upload" ? "Uploaded" : project.sourcePlatform}
                    {" · "}
                    {new Date(project.createdAt).toLocaleDateString()}
                  </p>
                </div>

                <div className="flex items-center gap-2 flex-shrink-0">
                  <span className="px-2 py-1 text-xs rounded bg-secondary">
                    {project.status}
                  </span>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
