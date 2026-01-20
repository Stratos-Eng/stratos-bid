"use client"

import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"

interface SearchMatch {
  documentId: string
  documentName: string
  pageNumber: number
  x: number
  y: number
  similarity: number
  ocrText?: string
  thumbnail?: string
}

interface SymbolSearchQuery {
  documentId: string
  pageNumber: number
  x: number
  y: number
  thumbnail: string
  ocrText?: string
  ocrConfidence?: number
}

interface SymbolSearchResultsProps {
  isOpen: boolean
  loading: boolean
  query?: SymbolSearchQuery
  searchMethod: "text" | "visual" | "none"
  matches: SearchMatch[]
  onClose: () => void
  onSelectMatch: (documentId: string, pageNumber: number) => void
}

export function SymbolSearchResults({
  isOpen,
  loading,
  query,
  searchMethod,
  matches,
  onClose,
  onSelectMatch,
}: SymbolSearchResultsProps) {
  if (!isOpen) return null

  return (
    <div className="w-80 border-l border-border bg-card flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between p-3 border-b border-border">
        <h3 className="font-medium text-sm">Symbol Search</h3>
        <button
          onClick={onClose}
          className="text-muted-foreground hover:text-foreground p-1"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      {/* Loading state */}
      {loading && (
        <div className="flex-1 flex items-center justify-center">
          <div className="flex flex-col items-center gap-3">
            <div className="w-8 h-8 border-2 border-primary border-t-transparent rounded-full animate-spin" />
            <span className="text-sm text-muted-foreground">Searching...</span>
          </div>
        </div>
      )}

      {/* Results */}
      {!loading && query && (
        <div className="flex-1 overflow-y-auto">
          {/* Clicked region preview */}
          <div className="p-3 border-b border-border bg-muted/30">
            <div className="text-xs text-muted-foreground mb-2">Clicked Region</div>
            <div className="flex gap-3">
              {query.thumbnail && (
                <div className="w-16 h-16 rounded border border-border overflow-hidden bg-white flex-shrink-0">
                  <img
                    src={`data:image/png;base64,${query.thumbnail}`}
                    alt="Selected region"
                    className="w-full h-full object-contain"
                  />
                </div>
              )}
              <div className="flex-1 min-w-0">
                {query.ocrText ? (
                  <div>
                    <div className="text-xs text-muted-foreground">Detected text:</div>
                    <div className="font-mono text-sm truncate">{query.ocrText}</div>
                    {query.ocrConfidence && (
                      <div className="text-xs text-muted-foreground mt-1">
                        Confidence: {Math.round(query.ocrConfidence * 100)}%
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="text-xs text-muted-foreground">
                    No text detected - using visual search
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Search method indicator */}
          <div className="px-3 py-2 border-b border-border">
            <div className="flex items-center gap-2">
              <span className={cn(
                "inline-block w-2 h-2 rounded-full",
                searchMethod === "text" && "bg-green-500",
                searchMethod === "visual" && "bg-amber-500",
                searchMethod === "none" && "bg-gray-400"
              )} />
              <span className="text-xs text-muted-foreground">
                {searchMethod === "text" && "Text search"}
                {searchMethod === "visual" && "Visual similarity search"}
                {searchMethod === "none" && "No search performed"}
              </span>
            </div>
          </div>

          {/* Matches */}
          {matches.length > 0 ? (
            <div>
              <div className="px-3 py-2 bg-muted/50 border-b border-border">
                <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                  {matches.length} Match{matches.length !== 1 ? "es" : ""} Found
                </span>
              </div>
              {matches.map((match, index) => (
                <button
                  key={`${match.documentId}-${match.pageNumber}-${index}`}
                  onClick={() => onSelectMatch(match.documentId, match.pageNumber)}
                  className="w-full text-left p-3 border-b border-border hover:bg-muted/50 transition-colors"
                >
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-sm font-medium truncate flex-1">
                      {match.documentName}
                    </span>
                    <span className="text-xs text-muted-foreground ml-2">
                      p.{match.pageNumber}
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <div className="flex-1 h-1 bg-secondary rounded-full overflow-hidden">
                      <div
                        className={cn(
                          "h-full",
                          match.similarity >= 0.8 ? "bg-green-500" :
                          match.similarity >= 0.5 ? "bg-amber-500" : "bg-red-500"
                        )}
                        style={{ width: `${Math.round(match.similarity * 100)}%` }}
                      />
                    </div>
                    <span className="text-xs text-muted-foreground">
                      {Math.round(match.similarity * 100)}%
                    </span>
                  </div>
                  {match.ocrText && (
                    <div className="text-xs text-muted-foreground mt-1 truncate">
                      "{match.ocrText}"
                    </div>
                  )}
                </button>
              ))}
            </div>
          ) : (
            <div className="p-6 text-center">
              <div className="text-muted-foreground text-sm">
                No similar symbols found
              </div>
              <div className="text-xs text-muted-foreground mt-2">
                Try clicking on a different symbol or area
              </div>
            </div>
          )}
        </div>
      )}

      {/* Footer */}
      <div className="p-3 border-t border-border">
        <Button
          variant="outline"
          size="sm"
          className="w-full"
          onClick={onClose}
        >
          Close
        </Button>
      </div>
    </div>
  )
}
