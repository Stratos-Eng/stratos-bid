"use client"

import { useState, useEffect } from "react"
import { useVerificationStore } from "@/lib/stores/verification-store"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

interface VerifyModeProps {
  documents: { id: string; filename: string; pageCount: number }[]
  bidId: string
}

export function VerifyMode({ documents, bidId }: VerifyModeProps) {
  const {
    leftPaneDocId,
    rightPaneDocId,
    setLeftPaneDoc,
    setRightPaneDoc,
    setMode,
    items,
    updateItem,
  } = useVerificationStore()

  const [leftPage, setLeftPage] = useState(1)
  const [rightPage, setRightPage] = useState(1)
  const [activePane, setActivePane] = useState<"left" | "right">("left")

  const leftDoc = documents.find((d) => d.id === leftPaneDocId) ?? documents[0]
  const rightDoc = documents.find((d) => d.id === rightPaneDocId) ?? documents[1] ?? documents[0]

  // Initialize panes if needed
  useEffect(() => {
    if (!leftPaneDocId && documents.length > 0) {
      setLeftPaneDoc(documents[0].id)
    }
    if (!rightPaneDocId && documents.length > 1) {
      setRightPaneDoc(documents[1].id)
    }
  }, [leftPaneDocId, rightPaneDocId, documents, setLeftPaneDoc, setRightPaneDoc])

  // Trust Left: Verify all items from left document
  const handleTrustLeft = async () => {
    const leftDocItems = items.filter((i) => i.documentId === leftPaneDocId)

    for (const item of leftDocItems) {
      await fetch(`/api/bids/${bidId}/line-items`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ itemId: item.id, updates: { reviewStatus: "verified" } }),
      })
      updateItem(item.id, { status: "verified" })
    }
  }

  // Trust Right: Verify all items from right document
  const handleTrustRight = async () => {
    const rightDocItems = items.filter((i) => i.documentId === rightPaneDocId)

    for (const item of rightDocItems) {
      await fetch(`/api/bids/${bidId}/line-items`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ itemId: item.id, updates: { reviewStatus: "verified" } }),
      })
      updateItem(item.id, { status: "verified" })
    }
  }

  // Flag for RFI: Flag all items from both documents
  const handleFlagForRFI = async () => {
    const relevantItems = items.filter(
      (i) => i.documentId === leftPaneDocId || i.documentId === rightPaneDocId
    )

    for (const item of relevantItems) {
      await fetch(`/api/bids/${bidId}/line-items`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          itemId: item.id,
          updates: {
            reviewStatus: "flagged",
            notes: "Flagged for RFI - conflicting specs",
          },
        }),
      })
      updateItem(item.id, { status: "flagged", notes: "Flagged for RFI - conflicting specs" })
    }
  }

  const renderPane = (
    doc: typeof leftDoc | undefined,
    page: number,
    setPage: (p: number) => void,
    setDocId: (id: string) => void,
    isActive: boolean,
    side: "left" | "right"
  ) => (
    <div
      className={cn(
        "flex h-full flex-col border-border",
        side === "left" ? "border-r" : "",
        isActive && "ring-2 ring-primary ring-inset"
      )}
      onClick={() => setActivePane(side)}
    >
      {/* Pane Header */}
      <div className="flex items-center justify-between border-b border-border bg-background px-3 py-2">
        <select
          value={doc?.id ?? ""}
          onChange={(e) => {
            setDocId(e.target.value)
            setPage(1)
          }}
          className="rounded border border-border bg-background px-2 py-1 text-xs"
        >
          {documents.map((d) => (
            <option key={d.id} value={d.id}>
              {d.filename}
            </option>
          ))}
        </select>

        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            className="h-6 w-6 p-0"
            onClick={() => setPage(Math.max(1, page - 1))}
            disabled={page <= 1}
          >
            &larr;
          </Button>
          <span className="text-xs">
            {page}/{doc?.pageCount ?? 1}
          </span>
          <Button
            variant="ghost"
            size="sm"
            className="h-6 w-6 p-0"
            onClick={() => setPage(Math.min(doc?.pageCount ?? 1, page + 1))}
            disabled={page >= (doc?.pageCount ?? 1)}
          >
            &rarr;
          </Button>
        </div>
      </div>

      {/* Pane Content */}
      <div className="flex-1 overflow-auto bg-muted/30 p-4">
        {doc && (
          <img
            src={`/api/documents/${doc.id}/page/${page}?scale=1`}
            alt={`${doc.filename} page ${page}`}
            className="mx-auto shadow-lg"
          />
        )}
      </div>
    </div>
  )

  return (
    <div className="flex h-full flex-col">
      {/* Top Bar */}
      <div className="flex items-center justify-between border-b border-border bg-background px-4 py-2">
        <span className="text-sm font-medium">Compare Documents</span>
        <Button variant="ghost" size="sm" onClick={() => setMode("scan")}>
          &larr; Back to Scan
        </Button>
      </div>

      {/* Split Panes */}
      <div className="flex flex-1">
        <div className="w-1/2">
          {renderPane(
            leftDoc,
            leftPage,
            setLeftPage,
            setLeftPaneDoc,
            activePane === "left",
            "left"
          )}
        </div>
        <div className="w-1/2">
          {renderPane(
            rightDoc,
            rightPage,
            setRightPage,
            setRightPaneDoc,
            activePane === "right",
            "right"
          )}
        </div>
      </div>

      {/* Bottom Info Bar */}
      <div className="border-t border-border bg-background px-4 py-2">
        <div className="flex items-center justify-between text-sm">
          <span className="text-muted-foreground">
            Tab to switch panes | Esc to return to Scan
          </span>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={handleTrustLeft}>
              Trust Left
            </Button>
            <Button variant="outline" size="sm" onClick={handleTrustRight}>
              Trust Right
            </Button>
            <Button variant="outline" size="sm" onClick={handleFlagForRFI}>
              Flag for RFI
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}
