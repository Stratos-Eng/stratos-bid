import { create } from "zustand"

export type ItemStatus = "pending" | "approved" | "skipped"

export interface SignageItem {
  id: string
  description: string
  symbolCode: string | null
  quantity: string | null
  unit: string | null
  pageNumber: number | null
  pageX: number | null // Normalized PDF coordinate (0-1)
  pageY: number | null // Normalized PDF coordinate (0-1)
  confidence: number
  status: ItemStatus
  notes: string | null
  documentId: string
}

export interface ProjectDocument {
  id: string
  filename: string
  pageCount: number
  thumbnailsGenerated: boolean
}

interface ProjectState {
  // Project info
  projectId: string | null
  projectName: string | null
  setProject: (id: string, name: string) => void

  // Documents
  documents: ProjectDocument[]
  setDocuments: (docs: ProjectDocument[]) => void
  currentDocumentId: string | null
  currentPage: number
  setCurrentDocument: (docId: string | null) => void
  setCurrentPage: (page: number) => void
  nextPage: () => void
  prevPage: () => void
  nextDocument: () => void
  prevDocument: () => void

  // Items
  items: SignageItem[]
  setItems: (items: SignageItem[]) => void
  selectedItemId: string | null
  setSelectedItemId: (id: string | null) => void
  updateItem: (id: string, updates: Partial<SignageItem>) => void
  addItem: (item: SignageItem) => void

  // Actions
  approveItem: (id: string) => void
  skipItem: (id: string) => void
  nextItem: () => void
  prevItem: () => void

  // Panel state
  panelOpen: boolean
  setPanelOpen: (open: boolean) => void

  // Quick add mode
  quickAddMode: boolean
  setQuickAddMode: (mode: boolean) => void
  quickAddPosition: { x: number; y: number } | null // Screen position for form
  quickAddPdfCoords: { x: number; y: number } | null // Normalized PDF coordinates
  setQuickAddPosition: (pos: { x: number; y: number } | null, pdfCoords?: { x: number; y: number } | null) => void

  // Search
  isSearchOpen: boolean
  setSearchOpen: (open: boolean) => void
  toggleSearch: () => void
}

export const useProjectStore = create<ProjectState>((set, get) => ({
  // Project info
  projectId: null,
  projectName: null,
  setProject: (id, name) => set({ projectId: id, projectName: name }),

  // Documents
  documents: [],
  setDocuments: (docs) => {
    set({ documents: docs })
    // Auto-select first document if none selected
    if (docs.length > 0 && !get().currentDocumentId) {
      set({ currentDocumentId: docs[0].id, currentPage: 1 })
    }
  },
  currentDocumentId: null,
  currentPage: 1,
  setCurrentDocument: (docId) => set({ currentDocumentId: docId, currentPage: 1 }),
  setCurrentPage: (page) => set({ currentPage: page }),
  nextPage: () => {
    const { currentPage, currentDocumentId, documents } = get()
    const currentIndex = documents.findIndex(d => d.id === currentDocumentId)
    const doc = documents[currentIndex]

    if (doc && currentPage < doc.pageCount) {
      // More pages in current doc
      set({ currentPage: currentPage + 1 })
    } else if (currentIndex < documents.length - 1) {
      // Move to first page of next doc
      set({ currentDocumentId: documents[currentIndex + 1].id, currentPage: 1 })
    }
  },
  prevPage: () => {
    const { currentPage, currentDocumentId, documents } = get()
    const currentIndex = documents.findIndex(d => d.id === currentDocumentId)

    if (currentPage > 1) {
      // More pages in current doc
      set({ currentPage: currentPage - 1 })
    } else if (currentIndex > 0) {
      // Move to last page of previous doc
      const prevDoc = documents[currentIndex - 1]
      set({ currentDocumentId: prevDoc.id, currentPage: prevDoc.pageCount })
    }
  },
  nextDocument: () => {
    const { currentDocumentId, documents } = get()
    if (!currentDocumentId || documents.length <= 1) return
    const currentIndex = documents.findIndex(d => d.id === currentDocumentId)
    if (currentIndex < documents.length - 1) {
      set({ currentDocumentId: documents[currentIndex + 1].id, currentPage: 1 })
    }
  },
  prevDocument: () => {
    const { currentDocumentId, documents } = get()
    if (!currentDocumentId || documents.length <= 1) return
    const currentIndex = documents.findIndex(d => d.id === currentDocumentId)
    if (currentIndex > 0) {
      set({ currentDocumentId: documents[currentIndex - 1].id, currentPage: 1 })
    }
  },

  // Items
  items: [],
  setItems: (items) => set({ items }),
  selectedItemId: null,
  setSelectedItemId: (id) => {
    set({ selectedItemId: id, panelOpen: id !== null })
    // Navigate to item's page when selected
    const item = get().items.find(i => i.id === id)
    if (item && item.pageNumber) {
      set({
        currentDocumentId: item.documentId,
        currentPage: item.pageNumber
      })
    }
  },
  updateItem: (id, updates) =>
    set((state) => ({
      items: state.items.map((item) =>
        item.id === id ? { ...item, ...updates } : item
      ),
    })),
  addItem: (item) => set((state) => ({ items: [...state.items, item] })),

  // Actions
  approveItem: (id) => {
    get().updateItem(id, { status: "approved" })
    // Auto-advance to next pending item
    setTimeout(() => get().nextItem(), 100)
  },
  skipItem: (id) => {
    get().updateItem(id, { status: "skipped" })
    setTimeout(() => get().nextItem(), 100)
  },
  nextItem: () => {
    const { items, selectedItemId } = get()
    const pendingItems = items.filter(i => i.status === "pending")
    if (pendingItems.length === 0) {
      set({ selectedItemId: null, panelOpen: false })
      return
    }

    const currentIndex = selectedItemId
      ? items.findIndex(i => i.id === selectedItemId)
      : -1

    // Find next pending item after current
    for (let i = currentIndex + 1; i < items.length; i++) {
      if (items[i].status === "pending") {
        get().setSelectedItemId(items[i].id)
        return
      }
    }
    // Wrap around
    for (let i = 0; i <= currentIndex; i++) {
      if (items[i].status === "pending") {
        get().setSelectedItemId(items[i].id)
        return
      }
    }
  },
  prevItem: () => {
    const { items, selectedItemId } = get()
    if (!selectedItemId) return

    const currentIndex = items.findIndex(i => i.id === selectedItemId)
    // Find previous pending item
    for (let i = currentIndex - 1; i >= 0; i--) {
      if (items[i].status === "pending") {
        get().setSelectedItemId(items[i].id)
        return
      }
    }
  },

  // Panel state
  panelOpen: false,
  setPanelOpen: (open) => set({ panelOpen: open }),

  // Quick add mode
  quickAddMode: false,
  setQuickAddMode: (mode) => set({ quickAddMode: mode }),
  quickAddPosition: null,
  quickAddPdfCoords: null,
  setQuickAddPosition: (pos, pdfCoords) => set({
    quickAddPosition: pos,
    quickAddPdfCoords: pdfCoords ?? null,
  }),

  // Search
  isSearchOpen: false,
  setSearchOpen: (open) => set({ isSearchOpen: open }),
  toggleSearch: () => set((state) => ({ isSearchOpen: !state.isSearchOpen })),
}))
