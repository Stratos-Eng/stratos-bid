import { useEffect, useCallback } from "react"
import { useVerificationStore } from "@/lib/stores/verification-store"

type ShortcutHandler = () => void

interface Shortcuts {
  [key: string]: ShortcutHandler
}

export function useKeyboardShortcuts(bidId: string, additionalShortcuts?: Shortcuts) {
  const {
    mode,
    setMode,
    items,
    selectedItemId,
    setSelectedItemId,
    updateItem,
    persistItemStatus,
    nextReviewItem,
    prevReviewItem,
    reviewQueue,
    currentReviewIndex,
  } = useVerificationStore()

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      // Ignore if typing in input/textarea
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement
      ) {
        return
      }

      const key = e.key.toLowerCase()
      const hasModifier = e.metaKey || e.ctrlKey

      // Mode switching: 1, 2, 3
      if (key === "1" && !hasModifier) {
        e.preventDefault()
        setMode("scan")
        return
      }
      if (key === "2" && !hasModifier) {
        e.preventDefault()
        setMode("review")
        return
      }
      if (key === "3" && !hasModifier) {
        e.preventDefault()
        setMode("verify")
        return
      }

      // Scan mode shortcuts
      if (mode === "scan") {
        // J/K navigation
        if (key === "j" || key === "arrowdown") {
          e.preventDefault()
          const currentIndex = items.findIndex((i) => i.id === selectedItemId)
          const nextIndex = Math.min(currentIndex + 1, items.length - 1)
          setSelectedItemId(items[nextIndex]?.id ?? null)
          return
        }
        if (key === "k" || key === "arrowup") {
          e.preventDefault()
          const currentIndex = items.findIndex((i) => i.id === selectedItemId)
          const prevIndex = Math.max(currentIndex - 1, 0)
          setSelectedItemId(items[prevIndex]?.id ?? null)
          return
        }

        // V to verify
        if (key === "v" && selectedItemId) {
          e.preventDefault()
          updateItem(selectedItemId, { status: "verified" })
          persistItemStatus(selectedItemId, "verified", bidId)
          return
        }

        // F to flag
        if (key === "f" && selectedItemId) {
          e.preventDefault()
          updateItem(selectedItemId, { status: "flagged" })
          persistItemStatus(selectedItemId, "flagged", bidId)
          return
        }

        // Enter to open in review mode
        if (key === "enter" && selectedItemId) {
          e.preventDefault()
          setMode("review")
          return
        }
      }

      // Review mode shortcuts
      if (mode === "review") {
        // V or Enter to verify and next
        if (key === "v" || key === "enter") {
          e.preventDefault()
          const currentItemId = reviewQueue[currentReviewIndex]
          if (currentItemId) {
            updateItem(currentItemId, { status: "verified" })
            persistItemStatus(currentItemId, "verified", bidId)
            nextReviewItem()
          }
          return
        }

        // F to flag
        if (key === "f") {
          e.preventDefault()
          const currentItemId = reviewQueue[currentReviewIndex]
          if (currentItemId) {
            updateItem(currentItemId, { status: "flagged" })
            persistItemStatus(currentItemId, "flagged", bidId)
          }
          return
        }

        // Arrow keys for navigation
        if (key === "arrowright") {
          e.preventDefault()
          nextReviewItem()
          return
        }
        if (key === "arrowleft") {
          e.preventDefault()
          prevReviewItem()
          return
        }

        // Escape to return to scan
        if (key === "escape") {
          e.preventDefault()
          setMode("scan")
          return
        }
      }

      // Verify mode shortcuts
      if (mode === "verify") {
        // Tab to switch panes
        if (key === "tab" && !hasModifier) {
          e.preventDefault()
          // Toggle active pane (implementation depends on UI)
          return
        }

        // Escape to return to scan
        if (key === "escape") {
          e.preventDefault()
          setMode("scan")
          return
        }
      }

      // Additional shortcuts
      if (additionalShortcuts?.[key]) {
        e.preventDefault()
        additionalShortcuts[key]()
      }
    },
    [
      mode,
      setMode,
      items,
      selectedItemId,
      setSelectedItemId,
      updateItem,
      persistItemStatus,
      nextReviewItem,
      prevReviewItem,
      reviewQueue,
      currentReviewIndex,
      bidId,
      additionalShortcuts,
    ]
  )

  useEffect(() => {
    document.addEventListener("keydown", handleKeyDown)
    return () => document.removeEventListener("keydown", handleKeyDown)
  }, [handleKeyDown])
}
