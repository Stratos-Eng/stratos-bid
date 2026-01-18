"use client"

import { useEffect, useCallback, useState } from "react"
import { useParams, useRouter } from "next/navigation"
import useSWR from "swr"
import { useProjectStore } from "@/lib/stores/project-store"
import { Filmstrip } from "@/components/projects/filmstrip"
import { ProjectViewer } from "@/components/projects/project-viewer"
import { ItemPanel } from "@/components/projects/item-panel"
import { QuickAddForm } from "@/components/projects/quick-add-form"
import { ItemsList } from "@/components/projects/items-list"
import { SearchPanel } from "@/components/projects/search-panel"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

const fetcher = (url: string) => fetch(url).then((r) => r.json())

export default function ProjectPage() {
  const params = useParams()
  const router = useRouter()
  const projectId = params.id as string

  const {
    setProject,
    setDocuments,
    setItems,
    documents,
    items,
    currentDocumentId,
    currentPage,
    setCurrentDocument,
    setCurrentPage,
    nextPage,
    prevPage,
    nextDocument,
    prevDocument,
    selectedItemId,
    setSelectedItemId,
    panelOpen,
    setPanelOpen,
    approveItem,
    skipItem,
    quickAddMode,
    setQuickAddMode,
    quickAddPosition,
    quickAddPdfCoords,
    setQuickAddPosition,
    isSearchOpen,
    setSearchOpen,
    toggleSearch,
  } = useProjectStore()

  // Fetch project data - poll faster when extraction is in progress
  const { data, error, mutate } = useSWR(`/api/projects/${projectId}`, fetcher, {
    refreshInterval: (latestData) => {
      if (!latestData?.documents) return 0
      const statuses = latestData.documents.map((d: any) => d.extractionStatus || "not_started")
      const isExtracting = statuses.some((s: string) => s === "extracting" || s === "queued")
      return isExtracting ? 2000 : 0 // Poll every 2s during extraction, stop when done
    },
  })

  // Local UI state
  const [filmstripCollapsed, setFilmstripCollapsed] = useState(false)
  const [highlightTerms, setHighlightTerms] = useState<string[]>([])

  // Load data into store
  useEffect(() => {
    if (data?.project) {
      setProject(data.project.id, data.project.name)
    }
    if (data?.documents) {
      setDocuments(data.documents)
    }
    if (data?.items) {
      setItems(
        data.items.map((i: any) => ({
          id: i.id,
          description: i.description,
          symbolCode: i.symbolCode,
          quantity: i.quantity,
          unit: i.unit,
          pageNumber: i.pageNumber,
          pageX: i.pageX ?? null,
          pageY: i.pageY ?? null,
          confidence: i.confidence,
          status: i.status === "approved" ? "approved" : i.status === "rejected" || i.status === "skipped" ? "skipped" : "pending",
          notes: i.notes,
          documentId: i.documentId,
        }))
      )
    }
  }, [data, setProject, setDocuments, setItems])

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Cmd+F / Ctrl+F opens search (always capture, even in inputs)
      if ((e.metaKey || e.ctrlKey) && e.key === "f") {
        e.preventDefault()
        toggleSearch()
        return
      }

      // Don't trigger other shortcuts if typing in an input
      if ((e.target as HTMLElement).tagName === "INPUT" || (e.target as HTMLElement).tagName === "TEXTAREA") {
        return
      }

      switch (e.key) {
        case "ArrowLeft":
          e.preventDefault()
          prevPage()
          break
        case "ArrowRight":
          e.preventDefault()
          nextPage()
          break
        case "ArrowUp":
          if (e.metaKey || e.ctrlKey) {
            e.preventDefault()
            prevDocument()
          }
          break
        case "ArrowDown":
          if (e.metaKey || e.ctrlKey) {
            e.preventDefault()
            nextDocument()
          }
          break
        case "a":
        case "A":
          if (selectedItemId) {
            e.preventDefault()
            handleApprove(selectedItemId)
          }
          break
        case "s":
        case "S":
          if (selectedItemId) {
            e.preventDefault()
            handleSkip(selectedItemId)
          }
          break
        case "e":
        case "E":
          if (selectedItemId) {
            e.preventDefault()
            setPanelOpen(true)
          }
          break
        case "Escape":
          setSelectedItemId(null)
          setQuickAddMode(false)
          setQuickAddPosition(null)
          break
        case "+":
        case "=":
          e.preventDefault()
          setQuickAddMode(true)
          break
        case "[":
          e.preventDefault()
          setFilmstripCollapsed((prev) => !prev)
          break
        case "/":
          // Also allow / to open search (common shortcut)
          e.preventDefault()
          setSearchOpen(true)
          break
      }
    }

    window.addEventListener("keydown", handleKeyDown)
    return () => window.removeEventListener("keydown", handleKeyDown)
  }, [selectedItemId, prevPage, nextPage, nextDocument, prevDocument, setPanelOpen, setSelectedItemId, setQuickAddMode, setQuickAddPosition, setFilmstripCollapsed, toggleSearch, setSearchOpen])

  const handleApprove = useCallback(
    async (id: string) => {
      approveItem(id)
      await fetch(`/api/projects/${projectId}/items`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ itemId: id, updates: { status: "approved" } }),
      })
    },
    [projectId, approveItem]
  )

  const handleSkip = useCallback(
    async (id: string) => {
      skipItem(id)
      await fetch(`/api/projects/${projectId}/items`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ itemId: id, updates: { status: "skipped" } }),
      })
    },
    [projectId, skipItem]
  )

  const handleQuickAdd = useCallback(
    async (data: { description: string; quantity: string; unit: string }) => {
      if (!currentDocumentId) return

      const res = await fetch(`/api/projects/${projectId}/items`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          documentId: currentDocumentId,
          description: data.description,
          quantity: data.quantity,
          unit: data.unit,
          pageNumber: currentPage,
          pageX: quickAddPdfCoords?.x ?? null,
          pageY: quickAddPdfCoords?.y ?? null,
        }),
      })

      if (res.ok) {
        mutate()
      }

      setQuickAddMode(false)
      setQuickAddPosition(null)
    },
    [projectId, currentDocumentId, currentPage, quickAddPdfCoords, mutate, setQuickAddMode, setQuickAddPosition]
  )

  const handleExport = () => {
    window.open(`/api/export?bidId=${projectId}`, "_blank")
  }

  const [extracting, setExtracting] = useState(false)
  const [viewMode, setViewMode] = useState<"pdf" | "list">("pdf")

  const handleExtract = useCallback(async () => {
    setExtracting(true)
    try {
      const res = await fetch(`/api/projects/${projectId}/extract`, {
        method: "POST",
      })
      if (res.ok) {
        mutate()
      } else {
        const data = await res.json()
        alert(data.error || "Failed to start extraction")
      }
    } catch (err) {
      alert("Failed to start extraction")
    } finally {
      setExtracting(false)
    }
  }, [projectId, mutate])

  if (error) {
    return (
      <div className="flex h-screen items-center justify-center">
        <div className="text-center">
          <h2 className="text-lg font-medium">Error loading project</h2>
          <Button className="mt-4" onClick={() => router.push("/projects")}>
            Back to Projects
          </Button>
        </div>
      </div>
    )
  }

  if (!data) {
    return (
      <div className="flex h-screen items-center justify-center">
        <div className="text-sm text-muted-foreground">Loading...</div>
      </div>
    )
  }

  const currentDoc = documents.find((d) => d.id === currentDocumentId)
  const pendingCount = items.filter((i) => i.status === "pending").length
  const approvedCount = items.filter((i) => i.status === "approved").length
  const selectedItem = items.find((i) => i.id === selectedItemId)

  // Compute overall extraction status
  // "queued" means waiting for background job - only show "extracting" if actively processing
  const extractionStatus = (() => {
    if (documents.length === 0) return "no_documents"
    const statuses = documents.map((d: any) => d.extractionStatus || "not_started")
    if (statuses.every((s: string) => s === "completed")) return "completed"
    if (statuses.some((s: string) => s === "extracting")) return "extracting"
    if (statuses.some((s: string) => s === "failed")) return "failed"
    if (statuses.some((s: string) => s === "queued")) return "queued"
    return "not_started"
  })()

  // Items on current page
  const pageItems = items.filter(
    (i) => i.documentId === currentDocumentId && i.pageNumber === currentPage
  )

  return (
    <div className="fixed inset-0 flex flex-col bg-background z-40">
      {/* Header */}
      <header className="flex items-center justify-between border-b border-border bg-background px-4 py-3">
        <div className="flex items-center gap-4">
          <Button variant="ghost" size="sm" onClick={() => router.push("/projects")}>
            &larr; Back
          </Button>
          <h1 className="font-medium">{data.project.name}</h1>
        </div>

        <div className="flex items-center gap-4">
          {/* Extraction Status */}
          {extractionStatus === "extracting" && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <div className="w-3 h-3 border-2 border-primary border-t-transparent rounded-full animate-spin" />
              <span>Extracting items...</span>
            </div>
          )}
          {extractionStatus === "queued" && (
            <div className="flex items-center gap-2">
              <div className="w-2 h-2 bg-amber-500 rounded-full" />
              <span className="text-sm text-amber-600">Queued</span>
              <Button
                variant="outline"
                size="sm"
                onClick={handleExtract}
                disabled={extracting}
              >
                {extracting ? "Starting..." : "Retry"}
              </Button>
            </div>
          )}
          {extractionStatus === "failed" && (
            <div className="flex items-center gap-2">
              <span className="text-sm text-destructive">Extraction failed</span>
              <Button
                variant="outline"
                size="sm"
                onClick={handleExtract}
                disabled={extracting}
              >
                {extracting ? "Retrying..." : "Retry"}
              </Button>
            </div>
          )}
          {extractionStatus === "completed" && items.length === 0 && (
            <div className="flex items-center gap-2">
              <span className="text-sm text-amber-600">No items found</span>
              <Button
                variant="outline"
                size="sm"
                onClick={handleExtract}
                disabled={extracting}
                title="Re-run extraction (may need API credits)"
              >
                {extracting ? "Retrying..." : "Retry"}
              </Button>
            </div>
          )}
          {extractionStatus === "not_started" && documents.length > 0 && (
            <Button
              variant="outline"
              size="sm"
              onClick={handleExtract}
              disabled={extracting}
            >
              {extracting ? "Starting..." : "Extract Items"}
            </Button>
          )}

          {/* Stats */}
          <div className="text-sm text-muted-foreground">
            <span className="text-foreground font-medium">{approvedCount}</span> approved
            <span className="mx-2">·</span>
            <span className="text-foreground font-medium">{pendingCount}</span> pending
          </div>

          {/* View Toggle */}
          <div className="flex rounded-md border border-border overflow-hidden">
            <button
              onClick={() => setViewMode("pdf")}
              className={cn(
                "px-3 py-1.5 text-sm font-medium transition-colors",
                viewMode === "pdf"
                  ? "bg-primary text-primary-foreground"
                  : "bg-background hover:bg-muted"
              )}
            >
              PDF
            </button>
            <button
              onClick={() => setViewMode("list")}
              className={cn(
                "px-3 py-1.5 text-sm font-medium transition-colors border-l border-border",
                viewMode === "list"
                  ? "bg-primary text-primary-foreground"
                  : "bg-background hover:bg-muted"
              )}
            >
              List
            </button>
          </div>

          {/* Search Button */}
          {viewMode === "pdf" && (
            <Button
              variant={isSearchOpen ? "primary" : "outline"}
              size="sm"
              onClick={toggleSearch}
              title="Search documents (Cmd+F)"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
            </Button>
          )}

          {/* Quick Add Toggle */}
          {viewMode === "pdf" && (
            <Button
              variant={quickAddMode ? "primary" : "outline"}
              size="sm"
              onClick={() => setQuickAddMode(!quickAddMode)}
            >
              + Add Item
            </Button>
          )}

          {/* Export */}
          <Button onClick={handleExport}>Export</Button>
        </div>
      </header>

      {/* Main Content */}
      <div className="flex flex-1 overflow-hidden">
        {/* Search Panel (replaces filmstrip when open) */}
        {viewMode === "pdf" && isSearchOpen && (
          <SearchPanel
            projectId={projectId}
            isOpen={isSearchOpen}
            onClose={() => setSearchOpen(false)}
            onSelectResult={(docId, pageNum, terms) => {
              setCurrentDocument(docId)
              setCurrentPage(pageNum)
              setHighlightTerms(terms)
            }}
          />
        )}

        {/* Filmstrip Sidebar - only in PDF mode when search is closed */}
        {viewMode === "pdf" && !isSearchOpen && (
          filmstripCollapsed ? (
            <div className="w-10 border-r border-border bg-muted/30 flex flex-col items-center py-2">
              <button
                onClick={() => setFilmstripCollapsed(false)}
                className="p-2 rounded hover:bg-muted transition-colors"
                title="Expand filmstrip"
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                </svg>
              </button>
              <div className="mt-2 text-xs text-muted-foreground [writing-mode:vertical-rl] rotate-180">
                {documents.length} docs
              </div>
            </div>
          ) : (
            <div className="relative h-full">
              <button
                onClick={() => setFilmstripCollapsed(true)}
                className="absolute top-2 right-2 z-10 p-1 rounded hover:bg-muted transition-colors"
                title="Collapse filmstrip"
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
                </svg>
              </button>
              <Filmstrip
                documents={documents}
                currentDocumentId={currentDocumentId}
                currentPage={currentPage}
                onSelectPage={(docId, page) => {
                  setCurrentDocument(docId)
                  setCurrentPage(page)
                  setHighlightTerms([]) // Clear highlights on manual navigation
                }}
                items={items}
              />
            </div>
          )
        )}

        {/* PDF Viewer */}
        {viewMode === "pdf" && (
          <div className="flex-1 relative">
            <ProjectViewer
              documentId={currentDocumentId}
              pageNumber={currentPage}
              totalPages={currentDoc?.pageCount || 1}
              items={pageItems}
              selectedItemId={selectedItemId}
              onSelectItem={setSelectedItemId}
              quickAddMode={quickAddMode}
              onQuickAddClick={(coords) => {
                setQuickAddPosition(
                  { x: coords.screenX, y: coords.screenY },
                  { x: coords.pdfX, y: coords.pdfY }
                )
              }}
              extractionStatus={extractionStatus}
              highlightTerms={highlightTerms}
            />

            {/* Quick Add Form Overlay */}
            {quickAddMode && quickAddPosition && (
              <QuickAddForm
                position={quickAddPosition}
                onSubmit={handleQuickAdd}
                onCancel={() => {
                  setQuickAddPosition(null)
                }}
              />
            )}
          </div>
        )}

        {/* Items List View */}
        {viewMode === "list" && (
          <div className="flex-1">
            <ItemsList
              items={items}
              documents={documents}
              selectedItemId={selectedItemId}
              onSelectItem={(id) => {
                setSelectedItemId(id)
                setViewMode("pdf") // Switch to PDF view when item clicked
              }}
            />
          </div>
        )}

        {/* Item Panel (Slide-out) */}
        {panelOpen && selectedItem && (
          <ItemPanel
            item={selectedItem}
            onApprove={() => handleApprove(selectedItem.id)}
            onSkip={() => handleSkip(selectedItem.id)}
            onClose={() => {
              setSelectedItemId(null)
              setPanelOpen(false)
            }}
            onUpdate={async (updates) => {
              await fetch(`/api/projects/${projectId}/items`, {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ itemId: selectedItem.id, updates }),
              })
              mutate()
            }}
          />
        )}
      </div>

      {/* Footer Status Bar */}
      <footer className="flex items-center justify-between border-t border-border bg-background px-4 py-2 text-sm">
        <div className="text-muted-foreground">
          Page {currentPage} of {currentDoc?.pageCount || 1}
        </div>
        <div className="flex items-center gap-4 text-muted-foreground">
          <span>{items.length} items</span>
          <span>·</span>
          <span>⌘F=search, A=approve, S=skip, ←→=pages, [=sidebar</span>
        </div>
      </footer>
    </div>
  )
}
