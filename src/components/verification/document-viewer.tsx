"use client"

import { useState, useEffect } from "react"
import dynamic from "next/dynamic"
import { useVerificationStore } from "@/lib/stores/verification-store"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

// Dynamically import OpenLayers viewer to avoid SSR issues
const OpenLayersTileViewer = dynamic(
  () => import("./openlayers-tile-viewer").then((mod) => mod.OpenLayersTileViewer),
  {
    ssr: false,
    loading: () => (
      <div className="flex h-full items-center justify-center">
        <div className="text-sm text-muted-foreground">Loading viewer...</div>
      </div>
    )
  }
)

interface Annotation {
  id: string
  type: "highlight" | "measurement" | "note"
  coordinates: number[][]
  label?: string
  color?: string
}

interface DocumentViewerProps {
  documents: {
    id: string
    filename: string
    pageCount: number
    tileConfig?: string | null
  }[]
  annotations?: Annotation[]
  onAnnotationClick?: (annotation: Annotation) => void
}

export function DocumentViewer({ documents, annotations = [], onAnnotationClick }: DocumentViewerProps) {
  const { currentDocumentId, currentPage, setCurrentDocument, setCurrentPage, selectedItemId } =
    useVerificationStore()
  const [scale, setScale] = useState(1)
  const [loading, setLoading] = useState(false)

  const currentDoc = documents.find((d) => d.id === currentDocumentId) ?? documents[0]
  const tileConfig = currentDoc?.tileConfig ? JSON.parse(currentDoc.tileConfig) : null

  useEffect(() => {
    if (!currentDocumentId && documents.length > 0) {
      setCurrentDocument(documents[0].id, 1)
    }
  }, [currentDocumentId, documents, setCurrentDocument])

  useEffect(() => {
    if (currentDoc) {
      setLoading(true)
    }
  }, [currentDoc, currentPage, scale])

  const handlePrevPage = () => {
    if (currentPage > 1) setCurrentPage(currentPage - 1)
  }

  const handleNextPage = () => {
    if (currentDoc && currentPage < currentDoc.pageCount) {
      setCurrentPage(currentPage + 1)
    }
  }

  if (!currentDoc) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground">
        No documents available
      </div>
    )
  }

  const imageUrl = `/api/documents/${currentDoc.id}/page/${currentPage}?scale=${scale}`

  return (
    <div className="flex h-full flex-col">
      {/* Toolbar */}
      <div className="flex items-center justify-between border-b border-border bg-background px-4 py-2">
        {/* Document Tabs */}
        <div className="flex items-center gap-1">
          {documents.map((doc) => (
            <button
              key={doc.id}
              onClick={() => setCurrentDocument(doc.id, 1)}
              className={cn(
                "rounded px-2 py-1 text-xs transition-colors",
                doc.id === currentDocumentId
                  ? "bg-secondary font-medium"
                  : "text-muted-foreground hover:bg-secondary/50"
              )}
            >
              {doc.filename.length > 20 ? doc.filename.slice(0, 20) + "..." : doc.filename}
            </button>
          ))}
        </div>

        {/* Page Navigation */}
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={handlePrevPage}
            disabled={currentPage <= 1}
          >
            &larr;
          </Button>
          <span className="text-sm">
            {currentPage} / {currentDoc.pageCount}
          </span>
          <Button
            variant="ghost"
            size="sm"
            onClick={handleNextPage}
            disabled={currentPage >= currentDoc.pageCount}
          >
            &rarr;
          </Button>
        </div>

        {/* Zoom Controls - only for non-tile mode */}
        {!tileConfig && (
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setScale((s) => Math.max(0.5, s - 0.25))}
            >
              &minus;
            </Button>
            <span className="text-xs text-muted-foreground">{Math.round(scale * 100)}%</span>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setScale((s) => Math.min(3, s + 0.25))}
            >
              +
            </Button>
          </div>
        )}
      </div>

      {/* Document View */}
      <div className="flex-1 overflow-hidden bg-muted/30">
        {tileConfig ? (
          <OpenLayersTileViewer
            documentId={currentDoc.id}
            pageNumber={currentPage}
            pageWidth={tileConfig.pageWidth}
            pageHeight={tileConfig.pageHeight}
            maxZoom={tileConfig.zoomLevels}
            annotations={annotations}
            onAnnotationClick={onAnnotationClick}
            highlightedItemId={selectedItemId}
          />
        ) : (
          <div className="h-full overflow-auto p-4">
            {loading && (
              <div className="flex h-full items-center justify-center">
                <div className="text-sm text-muted-foreground">Loading...</div>
              </div>
            )}
            <img
              src={imageUrl}
              alt={`Page ${currentPage}`}
              onLoad={() => setLoading(false)}
              onError={() => setLoading(false)}
              className={cn("mx-auto shadow-lg", loading && "hidden")}
            />
          </div>
        )}
      </div>
    </div>
  )
}
