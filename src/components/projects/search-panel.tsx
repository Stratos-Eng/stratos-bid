"use client"

import { useState, useEffect, useRef, useCallback } from "react"
import { cn } from "@/lib/utils"
import { extractSearchTerms } from "@/lib/highlight-matcher"

interface SearchResult {
  documentId: string
  documentName: string
  pageNumber: number
  snippet: string
  rank: number
}

interface IndexingStatus {
  totalPages: number
  indexedPages: number
  pagesNeedingOcr: number
}

interface SearchPanelProps {
  projectId: string
  isOpen: boolean
  onClose: () => void
  onSelectResult: (documentId: string, pageNumber: number, searchTerms: string[]) => void
}

export function SearchPanel({
  projectId,
  isOpen,
  onClose,
  onSelectResult,
}: SearchPanelProps) {
  const [query, setQuery] = useState("")
  const [results, setResults] = useState<SearchResult[]>([])
  const [indexingStatus, setIndexingStatus] = useState<IndexingStatus | null>(null)
  const [loading, setLoading] = useState(false)
  const [activeIndex, setActiveIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const resultsRef = useRef<HTMLDivElement>(null)

  // Focus input when panel opens
  useEffect(() => {
    if (isOpen && inputRef.current) {
      inputRef.current.focus()
    }
  }, [isOpen])

  // Debounced search
  useEffect(() => {
    if (!query.trim()) {
      setResults([])
      return
    }

    const debounceTimer = setTimeout(async () => {
      setLoading(true)
      try {
        const res = await fetch(
          `/api/projects/${projectId}/search?q=${encodeURIComponent(query)}`
        )
        if (res.ok) {
          const data = await res.json()
          setResults(data.results || [])
          setIndexingStatus(data.indexingStatus || null)
          setActiveIndex(0)
        }
      } catch (error) {
        console.error("Search error:", error)
      } finally {
        setLoading(false)
      }
    }, 300)

    return () => clearTimeout(debounceTimer)
  }, [query, projectId])

  // Scroll active result into view
  useEffect(() => {
    if (resultsRef.current && results.length > 0) {
      const activeElement = resultsRef.current.querySelector(
        `[data-index="${activeIndex}"]`
      )
      activeElement?.scrollIntoView({ block: "nearest" })
    }
  }, [activeIndex, results.length])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      switch (e.key) {
        case "ArrowDown":
          e.preventDefault()
          setActiveIndex((prev) => Math.min(prev + 1, results.length - 1))
          break
        case "ArrowUp":
          e.preventDefault()
          setActiveIndex((prev) => Math.max(prev - 1, 0))
          break
        case "Enter":
          e.preventDefault()
          if (results[activeIndex]) {
            const result = results[activeIndex]
            const terms = extractSearchTerms(query)
            onSelectResult(result.documentId, result.pageNumber, terms)
          }
          break
        case "Escape":
          e.preventDefault()
          onClose()
          break
      }
    },
    [results, activeIndex, onSelectResult, onClose]
  )

  if (!isOpen) return null

  return (
    <div className="w-72 border-r border-border bg-card flex flex-col h-full">
      {/* Search input */}
      <div className="p-3 border-b border-border">
        <div className="relative">
          <svg
            className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
            />
          </svg>
          <input
            ref={inputRef}
            type="text"
            placeholder="Search documents..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            className="w-full pl-9 pr-8 py-2 text-sm bg-background border border-border rounded-md focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent"
          />
          {query && (
            <button
              onClick={() => setQuery("")}
              className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-muted-foreground hover:text-foreground"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          )}
        </div>
        <div className="flex items-center justify-between mt-2">
          <span className="text-xs text-muted-foreground">
            {query ? `${results.length} results` : "Type to search"}
          </span>
          <button
            onClick={onClose}
            className="text-xs text-muted-foreground hover:text-foreground"
          >
            Close (Esc)
          </button>
        </div>
      </div>

      {/* Indexing status warning */}
      {indexingStatus && indexingStatus.indexedPages < indexingStatus.totalPages && (
        <div className="px-3 py-2 bg-amber-500/10 border-b border-amber-500/20">
          <p className="text-xs text-amber-600">
            {indexingStatus.indexedPages} of {indexingStatus.totalPages} pages indexed
          </p>
        </div>
      )}

      {/* Results */}
      <div ref={resultsRef} className="flex-1 overflow-y-auto">
        {loading && (
          <div className="flex items-center justify-center py-8">
            <div className="w-5 h-5 border-2 border-primary border-t-transparent rounded-full animate-spin" />
          </div>
        )}

        {!loading && query && results.length === 0 && (
          <div className="p-4 text-center text-sm text-muted-foreground">
            No results found for "{query}"
          </div>
        )}

        {!loading && results.map((result, index) => (
          <button
            key={`${result.documentId}-${result.pageNumber}`}
            data-index={index}
            onClick={() => onSelectResult(result.documentId, result.pageNumber, extractSearchTerms(query))}
            className={cn(
              "w-full text-left p-3 border-b border-border hover:bg-muted/50 transition-colors",
              index === activeIndex && "bg-muted"
            )}
          >
            <div className="flex items-center justify-between mb-1">
              <span className="text-xs font-medium text-foreground truncate flex-1">
                {result.documentName}
              </span>
              <span className="text-xs text-muted-foreground ml-2">
                p.{result.pageNumber}
              </span>
            </div>
            <p
              className="text-xs text-muted-foreground line-clamp-2"
              dangerouslySetInnerHTML={{ __html: result.snippet }}
            />
          </button>
        ))}
      </div>

      {/* Keyboard hints */}
      <div className="px-3 py-2 border-t border-border bg-muted/30">
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>↑↓ navigate</span>
          <span>Enter select</span>
          <span>Esc close</span>
        </div>
      </div>
    </div>
  )
}
