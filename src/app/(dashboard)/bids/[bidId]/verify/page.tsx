"use client"

import { useEffect } from "react"
import { useParams, useRouter } from "next/navigation"
import { useVerificationStore } from "@/lib/stores/verification-store"
import { useKeyboardShortcuts } from "@/hooks/use-keyboard-shortcuts"
import { ScanMode } from "@/components/verification/scan-mode"
import { ReviewMode } from "@/components/verification/review-mode"
import { VerifyMode } from "@/components/verification/verify-mode"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import useSWR from "swr"

const fetcher = (url: string) => fetch(url).then((r) => r.json())

export default function VerificationPage() {
  const params = useParams()
  const router = useRouter()
  const bidId = params.bidId as string

  const { mode, setMode, setItems, items } = useVerificationStore()

  // Fetch bid data
  const { data: bid, error: bidError } = useSWR(`/api/bids/${bidId}`, fetcher)
  const { data: documentsData } = useSWR(`/api/bids/${bidId}/documents`, fetcher)
  const { data: lineItemsData, mutate: mutateLineItems } = useSWR(`/api/bids/${bidId}/line-items`, fetcher)

  // Map 0-1 confidence to low/medium/high
  const getConfidenceLevel = (confidence: number): "low" | "medium" | "high" => {
    if (confidence >= 0.8) return "high"
    if (confidence >= 0.5) return "medium"
    return "low"
  }

  // Initialize items in store
  useEffect(() => {
    if (lineItemsData?.items) {
      setItems(
        lineItemsData.items.map((item: any) => {
          const confidence = item.extractionConfidence ?? 0.5
          return {
            id: item.id,
            category: item.category ?? "Unknown",
            description: item.description ?? "",
            quantity: item.estimatedQty,
            unit: item.unit,
            confidence,
            confidenceLevel: getConfidenceLevel(confidence),
            status: item.reviewStatus ?? "pending",
            pageNumber: item.pageNumber,
            pageReference: item.pageReference,
            documentId: item.documentId,
            notes: item.notes,
          }
        })
      )
    }
  }, [lineItemsData, setItems])

  // Enable keyboard shortcuts
  useKeyboardShortcuts(bidId)

  const handleExport = async () => {
    window.open(`/api/export?bidId=${bidId}`, "_blank")
  }

  if (bidError) {
    return (
      <div className="flex h-screen items-center justify-center">
        <div className="text-center">
          <h2 className="text-lg font-medium">Error loading bid</h2>
          <Button className="mt-4" onClick={() => router.push("/bids")}>
            Back to Bids
          </Button>
        </div>
      </div>
    )
  }

  if (!bid || !documentsData) {
    return (
      <div className="flex h-screen items-center justify-center">
        <div className="text-sm text-muted-foreground">Loading...</div>
      </div>
    )
  }

  const documents = documentsData.documents ?? []
  const verifiedCount = items.filter((i) => i.status === "verified").length
  const flaggedCount = items.filter((i) => i.status === "flagged").length
  const pendingCount = items.filter((i) => i.status === "pending").length

  // Aggregate extraction status from all documents
  const getAggregatedExtractionStatus = (): "pending" | "extracting" | "completed" | "failed" => {
    if (documents.length === 0) return "completed"

    const statuses = documents.map((d: { extractionStatus?: string }) => d.extractionStatus || "pending")

    // If any is extracting, show extracting
    if (statuses.includes("extracting")) return "extracting"
    // If any is pending, show pending
    if (statuses.includes("pending")) return "pending"
    // If any failed, show failed
    if (statuses.includes("failed")) return "failed"
    // All completed
    return "completed"
  }

  const extractionStatus = getAggregatedExtractionStatus()

  const handleRetryExtraction = async () => {
    try {
      const res = await fetch(`/api/bids/${bidId}/retry-extraction`, {
        method: "POST",
      })
      if (res.ok) {
        // Refresh documents data to show updated status
        window.location.reload() // Simple refresh for now
      }
    } catch (error) {
      console.error("Failed to retry extraction:", error)
    }
  }

  return (
    <div className="flex h-screen flex-col">
      {/* Header */}
      <header className="flex items-center justify-between border-b border-border bg-background px-4 py-3">
        <div className="flex items-center gap-4">
          <Button variant="ghost" size="sm" onClick={() => router.push("/bids")}>
            &larr; Back
          </Button>
          <h1 className="font-medium">{bid.title}</h1>
        </div>

        {/* Mode Switcher */}
        <div className="flex items-center gap-1 rounded-md border border-border p-1">
          {(["scan", "review", "verify"] as const).map((m, idx) => (
            <button
              key={m}
              onClick={() => setMode(m)}
              className={cn(
                "rounded px-3 py-1 text-sm transition-colors",
                mode === m
                  ? "bg-secondary font-medium"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              <span className="mr-1 text-xs text-muted-foreground">{idx + 1}</span>
              {m.charAt(0).toUpperCase() + m.slice(1)}
            </button>
          ))}
        </div>

        {/* Export */}
        <Button onClick={handleExport}>Export</Button>
      </header>

      {/* Warning Banner */}
      {(flaggedCount > 0 || pendingCount > 0) && (
        <div className="flex items-center justify-between border-b border-border bg-warning/10 px-4 py-2 text-sm">
          <span>
            {flaggedCount > 0 && `${flaggedCount} flagged`}
            {flaggedCount > 0 && pendingCount > 0 && ", "}
            {pendingCount > 0 && `${pendingCount} unverified`}
          </span>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setMode("review")}
          >
            Review now
          </Button>
        </div>
      )}

      {/* Main Content */}
      <main className="flex-1 overflow-hidden">
        {mode === "scan" && (
          <ScanMode
            bidId={bidId}
            documents={documents}
            extractionStatus={extractionStatus}
            onItemCreated={() => mutateLineItems()}
            onRetryExtraction={handleRetryExtraction}
          />
        )}
        {mode === "review" && <ReviewMode documents={documents} bidId={bidId} />}
        {mode === "verify" && <VerifyMode documents={documents} />}
      </main>
    </div>
  )
}
