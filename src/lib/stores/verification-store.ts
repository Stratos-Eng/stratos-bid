import { create } from "zustand"

export type VerificationMode = "scan" | "review" | "verify"
export type ItemStatus = "pending" | "verified" | "flagged"
export type ConfidenceLevel = "high" | "medium" | "low"

export interface LineItem {
  id: string
  category: string
  description: string
  quantity: string | null
  unit: string | null
  confidence: number
  confidenceLevel: ConfidenceLevel
  status: ItemStatus
  pageNumber: number | null
  pageReference: string | null
  documentId: string | null
  notes: string | null
}

interface VerificationState {
  // Mode
  mode: VerificationMode
  setMode: (mode: VerificationMode) => void

  // Items
  items: LineItem[]
  setItems: (items: LineItem[]) => void
  updateItem: (id: string, updates: Partial<LineItem>) => void

  // Selection
  selectedItemId: string | null
  setSelectedItemId: (id: string | null) => void

  // Review mode
  reviewQueue: string[] // Item IDs that need review
  currentReviewIndex: number
  setCurrentReviewIndex: (index: number) => void
  nextReviewItem: () => void
  prevReviewItem: () => void

  // Document view
  currentDocumentId: string | null
  currentPage: number
  setCurrentDocument: (docId: string | null, page?: number) => void
  setCurrentPage: (page: number) => void

  // Verify mode (split pane)
  leftPaneDocId: string | null
  rightPaneDocId: string | null
  setLeftPaneDoc: (docId: string | null) => void
  setRightPaneDoc: (docId: string | null) => void

  // Bulk actions
  selectedItemIds: Set<string>
  toggleItemSelection: (id: string) => void
  selectAll: () => void
  clearSelection: () => void
  bulkUpdateStatus: (status: ItemStatus) => void

  // Persistence
  persistItemStatus: (itemId: string, status: string, bidId: string) => Promise<void>
}

function getConfidenceLevel(confidence: number): ConfidenceLevel {
  if (confidence >= 0.8) return "high"
  if (confidence >= 0.5) return "medium"
  return "low"
}

export const useVerificationStore = create<VerificationState>((set, get) => ({
  // Mode
  mode: "scan",
  setMode: (mode) => set({ mode }),

  // Items
  items: [],
  setItems: (items) => {
    const itemsWithLevel = items.map((item) => ({
      ...item,
      confidenceLevel: getConfidenceLevel(item.confidence),
    }))
    // Build review queue from items needing attention
    const reviewQueue = itemsWithLevel
      .filter((i) => i.confidenceLevel !== "high" || i.status === "flagged")
      .map((i) => i.id)
    set({ items: itemsWithLevel, reviewQueue, currentReviewIndex: 0 })
  },
  updateItem: (id, updates) =>
    set((state) => ({
      items: state.items.map((item) =>
        item.id === id
          ? {
              ...item,
              ...updates,
              confidenceLevel: updates.confidence
                ? getConfidenceLevel(updates.confidence)
                : item.confidenceLevel,
            }
          : item
      ),
    })),

  // Selection
  selectedItemId: null,
  setSelectedItemId: (id) => set({ selectedItemId: id }),

  // Review mode
  reviewQueue: [],
  currentReviewIndex: 0,
  setCurrentReviewIndex: (index) => set({ currentReviewIndex: index }),
  nextReviewItem: () => {
    const { currentReviewIndex, reviewQueue } = get()
    if (currentReviewIndex < reviewQueue.length - 1) {
      set({ currentReviewIndex: currentReviewIndex + 1 })
    }
  },
  prevReviewItem: () => {
    const { currentReviewIndex } = get()
    if (currentReviewIndex > 0) {
      set({ currentReviewIndex: currentReviewIndex - 1 })
    }
  },

  // Document view
  currentDocumentId: null,
  currentPage: 1,
  setCurrentDocument: (docId, page = 1) =>
    set({ currentDocumentId: docId, currentPage: page }),
  setCurrentPage: (page) => set({ currentPage: page }),

  // Verify mode
  leftPaneDocId: null,
  rightPaneDocId: null,
  setLeftPaneDoc: (docId) => set({ leftPaneDocId: docId }),
  setRightPaneDoc: (docId) => set({ rightPaneDocId: docId }),

  // Bulk actions
  selectedItemIds: new Set(),
  toggleItemSelection: (id) =>
    set((state) => {
      const newSet = new Set(state.selectedItemIds)
      if (newSet.has(id)) {
        newSet.delete(id)
      } else {
        newSet.add(id)
      }
      return { selectedItemIds: newSet }
    }),
  selectAll: () =>
    set((state) => ({
      selectedItemIds: new Set(state.items.map((i) => i.id)),
    })),
  clearSelection: () => set({ selectedItemIds: new Set() }),
  bulkUpdateStatus: (status) =>
    set((state) => ({
      items: state.items.map((item) =>
        state.selectedItemIds.has(item.id) ? { ...item, status } : item
      ),
      selectedItemIds: new Set(),
    })),

  // Persistence
  persistItemStatus: async (itemId, status, bidId) => {
    try {
      await fetch(`/api/bids/${bidId}/line-items`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ itemId, updates: { reviewStatus: status } })
      })
    } catch (error) {
      console.error('Failed to persist status:', error)
    }
  },
}))
