"use client"

import { useRef, useEffect, useState } from "react"
import { cn } from "@/lib/utils"
import { LazyPdfThumbnail } from "@/components/documents/lazy-pdf-thumbnail"

interface DocumentType {
  id: string
  filename: string
  pageCount: number
  storagePath?: string
  thumbnailsGenerated?: boolean
}

interface FilmstripProps {
  documents: DocumentType[]
  currentDocumentId: string | null
  currentPage: number
  onSelectPage: (docId: string, page: number) => void
  items?: Array<{
    documentId: string
    pageNumber: number | null
  }>
}

// Cache for page labels per document
const pageLabelCache: Record<string, Record<number, string>> = {}
// Cache for PDF URLs per document
const pdfUrlCache: Record<string, string> = {}

// Chevron icon component
function ChevronIcon({ expanded }: { expanded: boolean }) {
  return (
    <svg
      className={cn("h-3 w-3 transition-transform flex-shrink-0", expanded && "rotate-90")}
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth={2}
    >
      <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
    </svg>
  )
}

// Search select for documents
function DocumentSearchSelect({
  documents,
  currentDocumentId,
  onSelect,
}: {
  documents: DocumentType[]
  currentDocumentId: string | null
  onSelect: (docId: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState("")
  const inputRef = useRef<HTMLInputElement>(null)

  const currentDoc = documents.find(d => d.id === currentDocumentId)
  const currentIndex = documents.findIndex(d => d.id === currentDocumentId)

  const filtered = documents.filter(doc =>
    doc.filename.toLowerCase().includes(search.toLowerCase())
  )


  // Focus input when opened
  useEffect(() => {
    if (open) {
      inputRef.current?.focus()
    }
  }, [open])

  const handleSelect = (docId: string) => {
    onSelect(docId)
    setOpen(false)
    setSearch("")
  }

  return (
    <div className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground text-left"
      >
        <span className="truncate flex-1">
          {currentDoc ? `${currentIndex + 1}/${documents.length}` : "Select"}
        </span>
        <svg className="h-3 w-3 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {open && (
        <>
          {/* Backdrop */}
          <div className="fixed inset-0 z-40" onClick={() => { setOpen(false); setSearch("") }} />

          {/* Dropdown - wider, positioned to right of filmstrip */}
          <div className="absolute top-full left-0 mt-1 z-50 bg-popover border border-border rounded-md shadow-lg w-72 max-w-[calc(100vw-160px)]">
            <div className="p-2 border-b border-border">
              <input
                ref={inputRef}
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search documents..."
                className="w-full text-sm bg-transparent border-none outline-none placeholder:text-muted-foreground"
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    setOpen(false)
                    setSearch("")
                  } else if (e.key === "Enter" && filtered.length === 1) {
                    handleSelect(filtered[0].id)
                  }
                }}
              />
            </div>
            <div className="max-h-64 overflow-y-auto overflow-x-hidden py-1">
              {filtered.length === 0 ? (
                <div className="px-3 py-4 text-sm text-muted-foreground text-center">
                  No documents found
                </div>
              ) : (
                filtered.map((doc) => {
                  const originalIdx = documents.findIndex(d => d.id === doc.id)
                  return (
                    <button
                      key={doc.id}
                      onClick={() => handleSelect(doc.id)}
                      className={cn(
                        "w-full px-3 py-2 text-left text-sm hover:bg-accent flex items-start gap-2",
                        doc.id === currentDocumentId && "bg-accent"
                      )}
                    >
                      <span className="text-muted-foreground flex-shrink-0 w-5">{originalIdx + 1}.</span>
                      <span className="break-words" title={doc.filename}>
                        {doc.filename.replace(/\.pdf$/i, "")}
                      </span>
                    </button>
                  )
                })
              )}
            </div>
          </div>
        </>
      )}
    </div>
  )
}

function ThumbnailImage({ pdfUrl, page, pageLabel }: { pdfUrl: string | null; page: number; pageLabel?: string }) {
  const displayLabel = pageLabel || String(page)

  // Show placeholder if no PDF URL available yet
  if (!pdfUrl) {
    return (
      <div className="w-full bg-muted flex items-center justify-center" style={{ paddingBottom: '75%', position: 'relative' }}>
        <span className="absolute text-[10px] text-muted-foreground">{displayLabel}</span>
      </div>
    )
  }

  // Use client-side PDF.js rendering via LazyPdfThumbnail
  return (
    <LazyPdfThumbnail
      pdfUrl={pdfUrl}
      pageNumber={page}
      width={96}
    />
  )
}

interface DocumentGroupProps {
  document: DocumentType
  isExpanded: boolean
  onToggle: () => void
  pageLabels: Record<number, string>
  pdfUrl: string | null
  itemCounts: Record<string, number>
  currentDocumentId: string | null
  currentPage: number
  onSelectPage: (docId: string, page: number) => void
  activeRef: React.RefObject<HTMLButtonElement | null>
}

function DocumentGroup({
  document,
  isExpanded,
  onToggle,
  pageLabels,
  pdfUrl,
  itemCounts,
  currentDocumentId,
  currentPage,
  onSelectPage,
  activeRef,
}: DocumentGroupProps) {
  // Count total items in this document
  const totalDocItems = Object.entries(itemCounts)
    .filter(([key]) => key.startsWith(`${document.id}-`))
    .reduce((sum, [, count]) => sum + count, 0)

  // Get display filename (remove extension, truncate)
  const displayName = document.filename
    .replace(/\.pdf$/i, "")
    .slice(0, 20)

  return (
    <div className="border-b border-border last:border-b-0">
      {/* Collapsible Header */}
      <button
        onClick={onToggle}
        className="sticky top-0 z-10 w-full flex items-center gap-1.5 px-2 py-2 bg-muted/90 backdrop-blur-sm text-left hover:bg-muted transition-colors"
      >
        <ChevronIcon expanded={isExpanded} />
        <span
          className="text-xs font-medium truncate flex-1"
          title={document.filename}
        >
          {displayName}
        </span>
        <span className="text-[10px] text-muted-foreground flex-shrink-0">
          {document.pageCount}p
        </span>
        {totalDocItems > 0 && (
          <span className="text-[10px] bg-primary/20 text-primary px-1.5 rounded-full flex-shrink-0">
            {totalDocItems}
          </span>
        )}
      </button>

      {/* Pages - collapsible */}
      {isExpanded && (
        <div className="p-2 space-y-2">
          {Array.from({ length: document.pageCount }, (_, i) => i + 1).map((page) => {
            const isActive = document.id === currentDocumentId && page === currentPage
            const pageLabel = pageLabels[page]
            const displayLabel = pageLabel || String(page)
            const itemCount = itemCounts[`${document.id}-${page}`] || 0

            return (
              <button
                key={`${document.id}-${page}`}
                ref={isActive ? activeRef : undefined}
                onClick={() => onSelectPage(document.id, page)}
                className={cn(
                  "w-full rounded border overflow-hidden transition-all relative group",
                  isActive
                    ? "ring-2 ring-primary border-primary"
                    : "border-border hover:border-primary/50"
                )}
              >
                <ThumbnailImage pdfUrl={pdfUrl} page={page} pageLabel={pageLabel} />

                {/* Page label overlay */}
                <div className="absolute bottom-0 inset-x-0 bg-black/60 text-white text-[10px] py-0.5 text-center truncate px-1">
                  {displayLabel}
                </div>

                {/* Item count badge */}
                {itemCount > 0 && (
                  <div className="absolute top-1 right-1 bg-primary text-primary-foreground text-[10px] font-medium px-1.5 py-0.5 rounded-full min-w-[18px] text-center">
                    {itemCount}
                  </div>
                )}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

export function Filmstrip({
  documents,
  currentDocumentId,
  currentPage,
  onSelectPage,
  items = [],
}: FilmstripProps) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const activeRef = useRef<HTMLButtonElement>(null)
  const [pageLabels, setPageLabels] = useState<Record<string, Record<number, string>>>({})
  const [pdfUrls, setPdfUrls] = useState<Record<string, string>>({})
  const [expandedDocs, setExpandedDocs] = useState<Record<string, boolean>>({})

  // Toggle document expansion
  const toggleDoc = (docId: string) => {
    setExpandedDocs(prev => ({
      ...prev,
      [docId]: !(prev[docId] ?? true), // Default to expanded
    }))
  }

  // Auto-expand active document when it changes
  useEffect(() => {
    if (currentDocumentId && expandedDocs[currentDocumentId] === false) {
      setExpandedDocs(prev => ({ ...prev, [currentDocumentId]: true }))
    }
  }, [currentDocumentId])

  // Fetch page labels and PDF URLs for all documents
  useEffect(() => {
    const fetchDocInfo = async () => {
      for (const doc of documents) {
        // Use cached data if available
        if (pageLabelCache[doc.id] && pdfUrlCache[doc.id]) {
          setPageLabels(prev => ({ ...prev, [doc.id]: pageLabelCache[doc.id] }))
          setPdfUrls(prev => ({ ...prev, [doc.id]: pdfUrlCache[doc.id] }))
          continue
        }

        // Use storagePath from document if available (faster, no API call)
        if (doc.storagePath) {
          pdfUrlCache[doc.id] = doc.storagePath
          setPdfUrls(prev => ({ ...prev, [doc.id]: doc.storagePath! }))
        }

        try {
          const res = await fetch(`/api/documents/${doc.id}/info`)
          if (res.ok) {
            const data = await res.json()
            // Store PDF URL
            if (data.pdfUrl) {
              pdfUrlCache[doc.id] = data.pdfUrl
              setPdfUrls(prev => ({ ...prev, [doc.id]: data.pdfUrl }))
            }
            // Store page labels
            if (data.pages) {
              const labels: Record<number, string> = {}
              data.pages.forEach((p: { label?: string }, idx: number) => {
                if (p.label) {
                  labels[idx + 1] = p.label
                }
              })
              pageLabelCache[doc.id] = labels
              setPageLabels(prev => ({ ...prev, [doc.id]: labels }))
            }
          }
        } catch {
          // Ignore errors, use page numbers
        }
      }
    }
    fetchDocInfo()
  }, [documents])

  // Scroll active item into view
  useEffect(() => {
    if (activeRef.current) {
      activeRef.current.scrollIntoView({
        behavior: "smooth",
        block: "nearest",
      })
    }
  }, [currentDocumentId, currentPage])

  // Compute item counts per page
  const itemCounts: Record<string, number> = {}
  for (const item of items) {
    if (item.pageNumber !== null) {
      const key = `${item.documentId}-${item.pageNumber}`
      itemCounts[key] = (itemCounts[key] || 0) + 1
    }
  }

  return (
    <div className="w-32 h-full border-r border-border bg-muted/30 flex flex-col">
      <div className="px-2 py-2 border-b border-border">
        {documents.length > 1 ? (
          <DocumentSearchSelect
            documents={documents}
            currentDocumentId={currentDocumentId}
            onSelect={(docId) => onSelectPage(docId, 1)}
          />
        ) : (
          <span className="text-xs font-medium text-muted-foreground">
            {documents.length} Document
          </span>
        )}
      </div>

      <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto scrollbar-thin">
        {documents.map((doc) => (
          <DocumentGroup
            key={doc.id}
            document={doc}
            isExpanded={expandedDocs[doc.id] ?? true}
            onToggle={() => toggleDoc(doc.id)}
            pageLabels={pageLabels[doc.id] || {}}
            pdfUrl={pdfUrls[doc.id] || null}
            itemCounts={itemCounts}
            currentDocumentId={currentDocumentId}
            currentPage={currentPage}
            onSelectPage={onSelectPage}
            activeRef={activeRef}
          />
        ))}

        {documents.length === 0 && (
          <div className="text-xs text-muted-foreground text-center py-4">
            No documents
          </div>
        )}
      </div>
    </div>
  )
}
