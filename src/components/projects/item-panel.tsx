"use client"

import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { cn } from "@/lib/utils"
import type { SignageItem } from "@/lib/stores/project-store"

interface ItemPanelProps {
  item: SignageItem
  onApprove: () => void
  onSkip: () => void
  onClose: () => void
  onUpdate: (updates: Partial<SignageItem>) => Promise<void>
}

export function ItemPanel({
  item,
  onApprove,
  onSkip,
  onClose,
  onUpdate,
}: ItemPanelProps) {
  const [editing, setEditing] = useState(false)
  const [description, setDescription] = useState(item.description)
  const [quantity, setQuantity] = useState(item.quantity || "")
  const [unit, setUnit] = useState(item.unit || "EA")
  const [notes, setNotes] = useState(item.notes || "")
  const [saving, setSaving] = useState(false)

  const handleSave = async () => {
    setSaving(true)
    await onUpdate({
      description,
      quantity,
      unit,
      notes,
    })
    setSaving(false)
    setEditing(false)
  }

  const confidencePercent = Math.round((item.confidence || 0.5) * 100)
  const confidenceColor =
    confidencePercent >= 80
      ? "text-green-600"
      : confidencePercent >= 50
        ? "text-yellow-600"
        : "text-red-600"

  return (
    <div className="w-80 border-l border-border bg-background flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between p-4 border-b border-border">
        <h3 className="font-medium">Item Details</h3>
        <button
          onClick={onClose}
          className="text-muted-foreground hover:text-foreground"
        >
          &times;
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {/* Symbol Code */}
        {item.symbolCode && (
          <div>
            <label className="text-xs text-muted-foreground">Symbol</label>
            <div className="font-mono text-lg">{item.symbolCode}</div>
          </div>
        )}

        {/* Description */}
        <div>
          <label className="text-xs text-muted-foreground">Description</label>
          {editing ? (
            <Textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
              className="mt-1"
            />
          ) : (
            <p className="mt-1">{item.description}</p>
          )}
        </div>

        {/* Quantity & Unit */}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-xs text-muted-foreground">Quantity</label>
            {editing ? (
              <Input
                value={quantity}
                onChange={(e) => setQuantity(e.target.value)}
                className="mt-1"
                placeholder="e.g., 4"
              />
            ) : (
              <p className="mt-1">{item.quantity || "-"}</p>
            )}
          </div>
          <div>
            <label className="text-xs text-muted-foreground">Unit</label>
            {editing ? (
              <select
                value={unit}
                onChange={(e) => setUnit(e.target.value)}
                className="mt-1 w-full h-10 rounded-md border border-input bg-background px-3 text-sm"
              >
                <option value="EA">EA</option>
                <option value="SF">SF</option>
                <option value="LF">LF</option>
                <option value="SET">SET</option>
              </select>
            ) : (
              <p className="mt-1">{item.unit || "EA"}</p>
            )}
          </div>
        </div>

        {/* Page Reference */}
        <div>
          <label className="text-xs text-muted-foreground">Page</label>
          <p className="mt-1">{item.pageNumber || "-"}</p>
        </div>

        {/* Confidence */}
        <div>
          <label className="text-xs text-muted-foreground">AI Confidence</label>
          <div className="mt-1 flex items-center gap-2">
            <div className="flex-1 h-2 bg-secondary rounded-full overflow-hidden">
              <div
                className={cn(
                  "h-full",
                  confidencePercent >= 80
                    ? "bg-green-500"
                    : confidencePercent >= 50
                      ? "bg-yellow-500"
                      : "bg-red-500"
                )}
                style={{ width: `${confidencePercent}%` }}
              />
            </div>
            <span className={cn("text-sm font-medium", confidenceColor)}>
              {confidencePercent}%
            </span>
          </div>
        </div>

        {/* Notes */}
        <div>
          <label className="text-xs text-muted-foreground">Notes</label>
          {editing ? (
            <Textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
              className="mt-1"
              placeholder="Add notes..."
            />
          ) : (
            <p className="mt-1 text-muted-foreground">
              {item.notes || "No notes"}
            </p>
          )}
        </div>

        {/* Status Badge */}
        <div>
          <label className="text-xs text-muted-foreground">Status</label>
          <div className="mt-1">
            <span
              className={cn(
                "inline-block px-2 py-1 rounded text-xs font-medium",
                item.status === "approved" && "bg-green-100 text-green-700",
                item.status === "skipped" && "bg-gray-100 text-gray-700",
                item.status === "pending" && "bg-blue-100 text-blue-700"
              )}
            >
              {item.status}
            </span>
          </div>
        </div>
      </div>

      {/* Actions */}
      <div className="p-4 border-t border-border space-y-2">
        {editing ? (
          <div className="flex gap-2">
            <Button
              variant="outline"
              className="flex-1"
              onClick={() => setEditing(false)}
            >
              Cancel
            </Button>
            <Button className="flex-1" onClick={handleSave} disabled={saving}>
              {saving ? "Saving..." : "Save"}
            </Button>
          </div>
        ) : (
          <>
            <div className="flex gap-2">
              <Button
                variant="outline"
                className="flex-1"
                onClick={() => setEditing(true)}
              >
                Edit
              </Button>
            </div>
            {item.status === "pending" && (
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  className="flex-1"
                  onClick={onSkip}
                >
                  Skip (S)
                </Button>
                <Button className="flex-1" onClick={onApprove}>
                  Approve (A)
                </Button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}
