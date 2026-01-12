"use client"

import { useState } from "react"
import { DocumentViewer } from "./document-viewer"
import { ItemsPanel } from "./items-panel"

interface ScanModeProps {
  bidId: string
  documents: { id: string; filename: string; pageCount: number }[]
  extractionStatus?: "pending" | "extracting" | "completed" | "failed"
  onItemCreated?: () => void
  onRetryExtraction?: () => void
}

export function ScanMode({ bidId, documents, extractionStatus, onItemCreated, onRetryExtraction }: ScanModeProps) {
  const [panelHeight, setPanelHeight] = useState(280) // Default height in px
  const [panelVisible, setPanelVisible] = useState(true)

  return (
    <div className="flex h-full flex-col">
      {/* Document Area */}
      <div
        className="flex-1 overflow-hidden"
        style={{ height: panelVisible ? `calc(100% - ${panelHeight}px)` : "100%" }}
      >
        <DocumentViewer documents={documents} />
      </div>

      {/* Resizable Bottom Panel */}
      {panelVisible && (
        <>
          {/* Resize Handle */}
          <div
            className="h-1 cursor-row-resize bg-border hover:bg-primary/50"
            onMouseDown={(e) => {
              const startY = e.clientY
              const startHeight = panelHeight
              const handleMouseMove = (e: MouseEvent) => {
                const delta = startY - e.clientY
                setPanelHeight(Math.max(150, Math.min(500, startHeight + delta)))
              }
              const handleMouseUp = () => {
                document.removeEventListener("mousemove", handleMouseMove)
                document.removeEventListener("mouseup", handleMouseUp)
              }
              document.addEventListener("mousemove", handleMouseMove)
              document.addEventListener("mouseup", handleMouseUp)
            }}
          />
          {/* Items Panel */}
          <div style={{ height: panelHeight }}>
            <ItemsPanel
              bidId={bidId}
              extractionStatus={extractionStatus}
              onItemCreated={onItemCreated}
              onRetryExtraction={onRetryExtraction}
            />
          </div>
        </>
      )}
    </div>
  )
}
