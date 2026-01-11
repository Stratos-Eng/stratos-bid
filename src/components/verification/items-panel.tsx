"use client"

import { useState } from "react"
import { useVerificationStore } from "@/lib/stores/verification-store"
import { cn } from "@/lib/utils"
import { StatusIndicator } from "@/components/ui/status-indicator"
import { Button } from "@/components/ui/button"

interface ItemsPanelProps {
  bidId: string
  extractionStatus?: "pending" | "extracting" | "completed" | "failed"
  onRetryExtraction?: () => void
  onItemCreated?: () => void
}

export function ItemsPanel({
  bidId,
  extractionStatus = "completed",
  onRetryExtraction,
  onItemCreated
}: ItemsPanelProps) {
  const {
    items,
    selectedItemId,
    setSelectedItemId,
    selectedItemIds,
    toggleItemSelection,
    selectAll,
    clearSelection,
    bulkUpdateStatus,
    setCurrentDocument,
  } = useVerificationStore()

  const [isAdding, setIsAdding] = useState(false)
  const [newItem, setNewItem] = useState({
    description: "",
    category: "",
    qty: "",
    unit: ""
  })
  const [isSubmitting, setIsSubmitting] = useState(false)

  const hasSelection = selectedItemIds.size > 0

  const handleBulkUpdate = async (status: "verified" | "flagged") => {
    if (selectedItemIds.size === 0) return

    try {
      const res = await fetch(`/api/bids/${bidId}/line-items`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          itemIds: Array.from(selectedItemIds),
          updates: { reviewStatus: status },
        }),
      })

      if (res.ok) {
        // Update local store after successful API call
        bulkUpdateStatus(status)
        onItemCreated?.() // Refresh data
      }
    } catch (error) {
      console.error("Failed to bulk update:", error)
    }
  }

  const handleRowClick = (item: typeof items[0]) => {
    setSelectedItemId(item.id)
    if (item.documentId && item.pageNumber) {
      setCurrentDocument(item.documentId, item.pageNumber)
    }
  }

  const handleAddItem = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!newItem.description.trim()) return

    setIsSubmitting(true)
    try {
      const res = await fetch(`/api/bids/${bidId}/line-items`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          description: newItem.description,
          category: newItem.category || null,
          estimatedQty: newItem.qty || null,
          unit: newItem.unit || null,
        }),
      })

      if (res.ok) {
        setNewItem({ description: "", category: "", qty: "", unit: "" })
        setIsAdding(false)
        onItemCreated?.()
      }
    } catch (error) {
      console.error("Failed to add item:", error)
    } finally {
      setIsSubmitting(false)
    }
  }

  const getConfidenceColor = (level: string) => {
    switch (level) {
      case "high":
        return "text-success"
      case "medium":
        return "text-warning"
      case "low":
        return "text-destructive"
      default:
        return "text-muted-foreground"
    }
  }

  const getStatusIndicator = (status: string) => {
    switch (status) {
      case "verified":
        return "verified"
      case "flagged":
        return "flagged"
      default:
        return "pending"
    }
  }

  return (
    <div className="flex h-full flex-col border-t border-border bg-background">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border px-4 py-2">
        <div className="flex items-center gap-4">
          <span className="text-sm font-medium">
            Items {items.filter((i) => i.status === "verified").length}/{items.length} verified
          </span>
          {hasSelection && (
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground">
                {selectedItemIds.size} selected
              </span>
              <Button
                size="sm"
                variant="outline"
                onClick={() => handleBulkUpdate("verified")}
                className="h-7 text-xs"
              >
                Verify
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => handleBulkUpdate("flagged")}
                className="h-7 text-xs"
              >
                Flag
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={clearSelection}
                className="h-7 text-xs"
              >
                Clear
              </Button>
            </div>
          )}
        </div>
        <div className="text-xs text-muted-foreground">
          J/K to navigate, V to verify, F to flag
        </div>
      </div>

      {/* Extraction Status Banner */}
      {extractionStatus === "extracting" && (
        <div className="flex items-center gap-2 border-b border-border bg-primary/5 px-4 py-2 text-sm">
          <div className="h-3 w-3 animate-spin rounded-full border-2 border-primary border-t-transparent" />
          <span>Extracting items from documents...</span>
        </div>
      )}
      {extractionStatus === "failed" && (
        <div className="flex items-center justify-between border-b border-destructive/30 bg-destructive/10 px-4 py-2 text-sm text-destructive">
          <span>Extraction failed</span>
          {onRetryExtraction && (
            <Button size="sm" variant="outline" onClick={onRetryExtraction} className="h-7 text-xs">
              Retry
            </Button>
          )}
        </div>
      )}
      {extractionStatus === "pending" && items.length === 0 && (
        <div className="flex items-center gap-2 border-b border-border bg-muted/50 px-4 py-2 text-sm text-muted-foreground">
          <span>Waiting for extraction to start...</span>
        </div>
      )}

      {/* Table */}
      <div className="flex-1 overflow-auto">
        {items.length === 0 && extractionStatus === "completed" ? (
          <div className="flex h-32 items-center justify-center text-sm text-muted-foreground">
            No items extracted. Add items manually below.
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-background">
              <tr className="border-b border-border text-left text-xs text-muted-foreground">
                <th className="w-8 p-2">
                  <input
                    type="checkbox"
                    checked={selectedItemIds.size === items.length && items.length > 0}
                    onChange={(e) => (e.target.checked ? selectAll() : clearSelection())}
                    className="h-3.5 w-3.5"
                  />
                </th>
                <th className="p-2">Item</th>
                <th className="w-20 p-2">Qty</th>
                <th className="w-24 p-2">Source</th>
                <th className="w-16 p-2">Conf.</th>
                <th className="w-24 p-2">Status</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr
                  key={item.id}
                  onClick={() => handleRowClick(item)}
                  className={cn(
                    "cursor-pointer border-b border-border transition-colors hover:bg-secondary/50",
                    selectedItemId === item.id && "bg-secondary",
                    selectedItemIds.has(item.id) && "bg-primary/10"
                  )}
                >
                  <td className="p-2">
                    <input
                      type="checkbox"
                      checked={selectedItemIds.has(item.id)}
                      onChange={(e) => {
                        e.stopPropagation()
                        toggleItemSelection(item.id)
                      }}
                      onClick={(e) => e.stopPropagation()}
                      className="h-3.5 w-3.5"
                    />
                  </td>
                  <td className="p-2">
                    <div className="font-medium">{item.category}</div>
                    <div className="text-xs text-muted-foreground line-clamp-1">
                      {item.description}
                    </div>
                  </td>
                  <td className="p-2 font-mono text-xs">
                    {item.quantity} {item.unit}
                  </td>
                  <td className="p-2 text-xs text-muted-foreground">
                    {item.pageReference ?? `p.${item.pageNumber}`}
                  </td>
                  <td className={cn("p-2 text-xs", getConfidenceColor(item.confidenceLevel))}>
                    {item.confidenceLevel.charAt(0).toUpperCase() + item.confidenceLevel.slice(1)}
                  </td>
                  <td className="p-2">
                    <StatusIndicator
                      status={getStatusIndicator(item.status) as any}
                      label={item.status}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Manual Item Creation */}
      <div className="border-t border-border">
        {isAdding ? (
          <form onSubmit={handleAddItem} className="space-y-2 p-3">
            <input
              placeholder="Description *"
              value={newItem.description}
              onChange={(e) => setNewItem((n) => ({ ...n, description: e.target.value }))}
              className="w-full rounded border border-border bg-background px-2 py-1.5 text-sm"
              autoFocus
            />
            <input
              placeholder="Category (e.g., Storefront, Room Signs)"
              value={newItem.category}
              onChange={(e) => setNewItem((n) => ({ ...n, category: e.target.value }))}
              className="w-full rounded border border-border bg-background px-2 py-1.5 text-sm"
            />
            <div className="flex gap-2">
              <input
                placeholder="Qty"
                value={newItem.qty}
                onChange={(e) => setNewItem((n) => ({ ...n, qty: e.target.value }))}
                className="w-24 rounded border border-border bg-background px-2 py-1.5 text-sm"
              />
              <input
                placeholder="Unit (SF, EA, LF)"
                value={newItem.unit}
                onChange={(e) => setNewItem((n) => ({ ...n, unit: e.target.value }))}
                className="w-24 rounded border border-border bg-background px-2 py-1.5 text-sm"
              />
            </div>
            <div className="flex gap-2">
              <Button size="sm" type="submit" disabled={isSubmitting || !newItem.description.trim()}>
                {isSubmitting ? "Adding..." : "Add Item"}
              </Button>
              <Button size="sm" variant="ghost" type="button" onClick={() => setIsAdding(false)}>
                Cancel
              </Button>
            </div>
          </form>
        ) : (
          <button
            onClick={() => setIsAdding(true)}
            className="w-full p-3 text-left text-sm text-muted-foreground hover:bg-secondary/50"
          >
            + Add item manually
          </button>
        )}
      </div>
    </div>
  )
}
