"use client"

import { useVerificationStore } from "@/lib/stores/verification-store"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

interface ReviewModeProps {
  documents: { id: string; filename: string; pageCount: number }[]
}

// Helper to generate confidence explanations
function getConfidenceReasons(item: any): string[] {
  const reasons: string[] = []

  if (item.confidenceLevel === "low") {
    reasons.push("Quantity may have been estimated from drawing")
    reasons.push("No explicit schedule entry found")
  } else if (item.confidenceLevel === "medium") {
    reasons.push("Quantity matches schedule, but limited cross-references")
    reasons.push("Similar items on same page may cause confusion")
  }

  if (!item.pageReference) {
    reasons.push("No specific drawing reference available")
  }

  return reasons.length > 0 ? reasons : ["Manual verification recommended"]
}

export function ReviewMode({ documents }: ReviewModeProps) {
  const {
    items,
    reviewQueue,
    currentReviewIndex,
    nextReviewItem,
    prevReviewItem,
    updateItem,
    setMode,
  } = useVerificationStore()

  const currentItemId = reviewQueue[currentReviewIndex]
  const currentItem = items.find((i) => i.id === currentItemId)

  if (!currentItem) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-center">
          <h2 className="text-lg font-medium">All items reviewed</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            No more items need attention.
          </p>
          <Button className="mt-4" onClick={() => setMode("scan")}>
            Return to Scan
          </Button>
        </div>
      </div>
    )
  }

  const currentDoc = documents.find((d) => d.id === currentItem.documentId)
  const imageUrl = currentDoc && currentItem.pageNumber
    ? `/api/documents/${currentDoc.id}/page/${currentItem.pageNumber}?scale=1.5`
    : null

  const handleVerify = () => {
    updateItem(currentItem.id, { status: "verified" })
    nextReviewItem()
  }

  const handleFlag = () => {
    updateItem(currentItem.id, { status: "flagged" })
  }

  const getConfidenceColor = (level: string) => {
    switch (level) {
      case "high": return "text-success"
      case "medium": return "text-warning"
      case "low": return "text-destructive"
      default: return "text-muted-foreground"
    }
  }

  const confidenceReasons = getConfidenceReasons(currentItem)

  return (
    <div className="flex h-full items-center justify-center bg-muted/20 p-8">
      <div className="w-full max-w-4xl rounded-lg border border-border bg-background shadow-lg">
        {/* Header */}
        <div className="border-b border-border p-4">
          <div className="flex items-center justify-between">
            <span className="text-sm text-muted-foreground">
              Reviewing: {reviewQueue.length} items need attention
            </span>
            <span className="text-sm">
              {currentReviewIndex + 1} of {reviewQueue.length}
            </span>
          </div>
          {/* Progress bar */}
          <div className="mt-2 h-1 w-full overflow-hidden rounded-full bg-secondary">
            <div
              className="h-full bg-primary transition-all"
              style={{
                width: `${((currentReviewIndex + 1) / reviewQueue.length) * 100}%`,
              }}
            />
          </div>
        </div>

        {/* Content */}
        <div className="p-6">
          {/* Document Preview */}
          {imageUrl && (
            <div className="mb-6 overflow-hidden rounded-md border border-border bg-muted/30">
              <img
                src={imageUrl}
                alt={`Page ${currentItem.pageNumber}`}
                className="mx-auto max-h-64 object-contain"
              />
            </div>
          )}

          {/* Item Details */}
          <div className="rounded-md border border-border p-4">
            <h3 className="font-medium">{currentItem.category}</h3>
            <div className="mt-4 grid grid-cols-2 gap-4 text-sm">
              <div>
                <span className="text-muted-foreground">Quantity:</span>{" "}
                <span className="font-mono">
                  {currentItem.quantity} {currentItem.unit}
                </span>
              </div>
              <div>
                <span className="text-muted-foreground">Confidence:</span>{" "}
                <span className={cn("font-medium", getConfidenceColor(currentItem.confidenceLevel))}>
                  {currentItem.confidenceLevel.charAt(0).toUpperCase() +
                    currentItem.confidenceLevel.slice(1)}{" "}
                  ({Math.round(currentItem.confidence * 100)}%)
                </span>
              </div>
              <div>
                <span className="text-muted-foreground">Source:</span>{" "}
                {currentItem.pageReference ?? `Page ${currentItem.pageNumber}`}
              </div>
              <div>
                <span className="text-muted-foreground">Found in:</span>{" "}
                {currentDoc?.filename ?? "Unknown document"}
              </div>
            </div>

            {/* Description */}
            {currentItem.description && (
              <div className="mt-4">
                <span className="text-sm text-muted-foreground">Description:</span>
                <p className="mt-1 text-sm">{currentItem.description}</p>
              </div>
            )}

            {/* Confidence Explanation */}
            {currentItem.confidenceLevel !== "high" && (
              <div className="mt-4 rounded bg-warning/10 p-3">
                <span className="text-sm font-medium text-warning">
                  Why {currentItem.confidenceLevel} confidence:
                </span>
                <ul className="mt-1 list-inside list-disc text-sm text-muted-foreground">
                  {confidenceReasons.map((reason, i) => (
                    <li key={i}>{reason}</li>
                  ))}
                </ul>
              </div>
            )}

            {/* Edit buttons */}
            <div className="mt-4 flex gap-2">
              <Button variant="outline" size="sm">
                Edit Quantity
              </Button>
              <Button variant="outline" size="sm">
                View All References
              </Button>
            </div>
          </div>
        </div>

        {/* Footer Actions */}
        <div className="flex items-center justify-between border-t border-border p-4">
          <Button
            variant="ghost"
            onClick={prevReviewItem}
            disabled={currentReviewIndex === 0}
          >
            &larr; Back
          </Button>
          <div className="flex gap-2">
            <Button variant="outline" onClick={handleFlag}>
              Flag
              <span className="ml-2 text-xs text-muted-foreground">F</span>
            </Button>
            <Button onClick={handleVerify}>
              Verify & Next &rarr;
              <span className="ml-2 text-xs text-muted-foreground">V</span>
            </Button>
          </div>
        </div>

        {/* Escape hint */}
        <div className="border-t border-border px-4 py-2 text-center text-xs text-muted-foreground">
          Press Esc to return to Scan mode
        </div>
      </div>
    </div>
  )
}
