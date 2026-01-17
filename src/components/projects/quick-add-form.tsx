"use client"

import { useState, useRef, useEffect } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"

interface QuickAddFormProps {
  position: { x: number; y: number }
  onSubmit: (data: { description: string; quantity: string; unit: string }) => void
  onCancel: () => void
}

export function QuickAddForm({ position, onSubmit, onCancel }: QuickAddFormProps) {
  const [description, setDescription] = useState("")
  const [quantity, setQuantity] = useState("")
  const [unit, setUnit] = useState("EA")
  const inputRef = useRef<HTMLInputElement>(null)

  // Focus input on mount
  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  // Handle escape key
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onCancel()
      }
    }
    window.addEventListener("keydown", handleKeyDown)
    return () => window.removeEventListener("keydown", handleKeyDown)
  }, [onCancel])

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!description.trim()) return

    onSubmit({
      description: description.trim(),
      quantity,
      unit,
    })
  }

  return (
    <div
      className="absolute z-50 bg-background border border-border rounded-lg shadow-lg p-4 w-72"
      style={{
        // Position near click but keep on screen
        left: Math.min(position.x + 20, window.innerWidth - 320),
        top: Math.min(position.y - 100, window.innerHeight - 300),
      }}
    >
      <form onSubmit={handleSubmit} className="space-y-3">
        <div>
          <label className="text-xs text-muted-foreground">Description *</label>
          <Input
            ref={inputRef}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="e.g., Tactile Exit Sign"
            className="mt-1"
          />
        </div>

        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="text-xs text-muted-foreground">Quantity</label>
            <Input
              value={quantity}
              onChange={(e) => setQuantity(e.target.value)}
              placeholder="e.g., 4"
              className="mt-1"
            />
          </div>
          <div>
            <label className="text-xs text-muted-foreground">Unit</label>
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
          </div>
        </div>

        <div className="flex gap-2 pt-2">
          <Button type="button" variant="outline" className="flex-1" onClick={onCancel}>
            Cancel
          </Button>
          <Button type="submit" className="flex-1" disabled={!description.trim()}>
            Add
          </Button>
        </div>
      </form>
    </div>
  )
}
