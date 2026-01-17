"use client"

import { cn } from "@/lib/utils"
import type { SignageItem } from "@/lib/stores/project-store"

interface ItemsListProps {
  items: SignageItem[]
  documents: { id: string; filename: string }[]
  selectedItemId: string | null
  onSelectItem: (id: string) => void
}

export function ItemsList({ items, documents, selectedItemId, onSelectItem }: ItemsListProps) {
  const getDocFilename = (docId: string) => {
    const doc = documents.find(d => d.id === docId)
    return doc?.filename || "Unknown"
  }

  const pendingItems = items.filter(i => i.status === "pending")
  const approvedItems = items.filter(i => i.status === "approved")
  const skippedItems = items.filter(i => i.status === "skipped")

  if (items.length === 0) {
    return (
      <div className="p-4 text-center text-muted-foreground">
        No items extracted yet
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full">
      {/* Summary */}
      <div className="px-4 py-3 border-b border-border bg-muted/30 text-sm">
        <span className="font-medium">{items.length}</span> items total
        <span className="mx-2">·</span>
        <span className="text-blue-600">{pendingItems.length} pending</span>
        <span className="mx-2">·</span>
        <span className="text-green-600">{approvedItems.length} approved</span>
        <span className="mx-2">·</span>
        <span className="text-gray-500">{skippedItems.length} skipped</span>
      </div>

      {/* Table */}
      <div className="flex-1 overflow-auto">
        <table className="w-full text-sm">
          <thead className="sticky top-0 bg-background border-b border-border">
            <tr className="text-left text-xs text-muted-foreground">
              <th className="px-3 py-2 font-medium">Status</th>
              <th className="px-3 py-2 font-medium">Symbol</th>
              <th className="px-3 py-2 font-medium">Description</th>
              <th className="px-3 py-2 font-medium">Qty</th>
              <th className="px-3 py-2 font-medium">Page</th>
              <th className="px-3 py-2 font-medium">Document</th>
              <th className="px-3 py-2 font-medium">Confidence</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr
                key={item.id}
                onClick={() => onSelectItem(item.id)}
                className={cn(
                  "border-b border-border/50 cursor-pointer transition-colors",
                  selectedItemId === item.id
                    ? "bg-primary/10"
                    : "hover:bg-muted/50"
                )}
              >
                <td className="px-3 py-2">
                  <span
                    className={cn(
                      "inline-block px-1.5 py-0.5 rounded text-xs font-medium",
                      item.status === "approved" && "bg-green-100 text-green-700",
                      item.status === "skipped" && "bg-gray-100 text-gray-600",
                      item.status === "pending" && "bg-blue-100 text-blue-700"
                    )}
                  >
                    {item.status}
                  </span>
                </td>
                <td className="px-3 py-2 font-mono text-xs">
                  {item.symbolCode || "-"}
                </td>
                <td className="px-3 py-2 max-w-[200px] truncate" title={item.description}>
                  {item.description}
                </td>
                <td className="px-3 py-2">
                  {item.quantity || "-"} {item.unit || ""}
                </td>
                <td className="px-3 py-2">
                  {item.pageNumber || "-"}
                </td>
                <td className="px-3 py-2 max-w-[150px] truncate text-xs text-muted-foreground" title={getDocFilename(item.documentId)}>
                  {getDocFilename(item.documentId)}
                </td>
                <td className="px-3 py-2">
                  <span
                    className={cn(
                      "text-xs font-medium",
                      item.confidence >= 0.8 && "text-green-600",
                      item.confidence >= 0.5 && item.confidence < 0.8 && "text-yellow-600",
                      item.confidence < 0.5 && "text-red-600"
                    )}
                  >
                    {Math.round(item.confidence * 100)}%
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
