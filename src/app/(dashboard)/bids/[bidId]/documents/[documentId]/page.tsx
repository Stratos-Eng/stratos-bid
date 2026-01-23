'use client';

import { useEffect, useState, useCallback } from 'react';
import { useParams, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { PdfPageRenderer } from '@/components/documents/pdf-page-renderer';
import { LazyPdfThumbnail } from '@/components/documents/lazy-pdf-thumbnail';

interface DocumentInfo {
  id: string;
  filename: string;
  pageCount: number;
  pdfUrl: string;
  bidId: string;
  bidTitle: string;
}

export default function DocumentViewerPage() {
  const params = useParams();
  const searchParams = useSearchParams();

  const documentId = params.documentId as string;
  const bidId = params.bidId as string;
  const initialPage = parseInt(searchParams.get('page') || '1', 10);

  const [currentPage, setCurrentPage] = useState(initialPage);
  const [docInfo, setDocInfo] = useState<DocumentInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [scale, setScale] = useState(1.5);

  // Fetch document info
  useEffect(() => {
    async function fetchDocInfo() {
      try {
        const response = await fetch(`/api/documents/${documentId}/info`);
        if (!response.ok) {
          throw new Error('Failed to load document info');
        }
        const data = await response.json();
        setDocInfo(data);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load document');
      } finally {
        setLoading(false);
      }
    }

    fetchDocInfo();
  }, [documentId]);

  // Update URL when page changes
  useEffect(() => {
    const newUrl = `/bids/${bidId}/documents/${documentId}?page=${currentPage}`;
    window.history.replaceState(null, '', newUrl);
  }, [currentPage, bidId, documentId]);

  const goToPage = useCallback((page: number) => {
    if (docInfo && page >= 1 && page <= docInfo.pageCount) {
      setCurrentPage(page);
    }
  }, [docInfo]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-screen">
        <div className="text-center">
          <div className="animate-spin w-8 h-8 border-4 border-blue-600 border-t-transparent rounded-full mx-auto mb-4" />
          <p className="text-gray-600">Loading document...</p>
        </div>
      </div>
    );
  }

  if (error || !docInfo) {
    return (
      <div className="flex items-center justify-center h-screen">
        <div className="text-center text-red-600">
          <p className="text-xl mb-2">Error</p>
          <p>{error || 'Document not found'}</p>
          <Link href={`/bids/${bidId}/items`} className="text-blue-600 hover:underline mt-4 block">
            Back to line items
          </Link>
        </div>
      </div>
    );
  }

  // Check if PDF URL is available
  if (!docInfo.pdfUrl) {
    return (
      <div className="flex items-center justify-center h-screen">
        <div className="text-center text-red-600">
          <p className="text-xl mb-2">PDF Not Available</p>
          <p>The document file could not be loaded. It may still be processing.</p>
          <Link href={`/bids/${bidId}/items`} className="text-blue-600 hover:underline mt-4 block">
            Back to line items
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="h-screen flex flex-col bg-gray-100">
      {/* Header */}
      <div className="bg-white border-b px-4 py-3 flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Link href={`/bids/${bidId}/items`} className="text-blue-600 hover:underline text-sm">
            &larr; Line Items
          </Link>
          <div>
            <h1 className="font-semibold text-gray-900">{docInfo.filename}</h1>
            <p className="text-xs text-gray-500">{docInfo.bidTitle}</p>
          </div>
        </div>

        {/* Page navigation */}
        <div className="flex items-center gap-4">
          {/* Zoom controls */}
          <div className="flex items-center gap-2">
            <button
              onClick={() => setScale(Math.max(0.5, scale - 0.25))}
              className="px-2 py-1 text-sm bg-gray-100 rounded hover:bg-gray-200"
            >
              -
            </button>
            <span className="text-sm text-gray-600">{Math.round(scale * 100)}%</span>
            <button
              onClick={() => setScale(Math.min(3, scale + 0.25))}
              className="px-2 py-1 text-sm bg-gray-100 rounded hover:bg-gray-200"
            >
              +
            </button>
          </div>

          {/* Page controls */}
          <div className="flex items-center gap-2">
            <button
              onClick={() => goToPage(currentPage - 1)}
              disabled={currentPage <= 1}
              className="px-3 py-1 text-sm bg-gray-100 rounded hover:bg-gray-200 disabled:opacity-50"
            >
              Prev
            </button>
            <div className="flex items-center gap-1">
              <input
                type="number"
                min={1}
                max={docInfo.pageCount}
                value={currentPage}
                onChange={(e) => goToPage(parseInt(e.target.value, 10) || 1)}
                className="w-12 px-2 py-1 text-sm border rounded text-center"
              />
              <span className="text-sm text-gray-600">of {docInfo.pageCount}</span>
            </div>
            <button
              onClick={() => goToPage(currentPage + 1)}
              disabled={currentPage >= docInfo.pageCount}
              className="px-3 py-1 text-sm bg-gray-100 rounded hover:bg-gray-200 disabled:opacity-50"
            >
              Next
            </button>
          </div>

          {/* Download PDF */}
          <a
            href={`/api/documents/${documentId}/view`}
            target="_blank"
            rel="noopener noreferrer"
            className="px-3 py-1 text-sm bg-blue-600 text-white rounded hover:bg-blue-700"
          >
            Open PDF
          </a>
        </div>
      </div>

      {/* Main content area with thumbnail strip */}
      <div className="flex-1 flex overflow-hidden">
        {/* Thumbnail strip on the left - client-side rendered with lazy loading */}
        <div className="w-[120px] bg-gray-900 overflow-auto p-2 flex flex-col gap-2">
          {Array.from({ length: docInfo.pageCount }, (_, i) => i + 1).map((pageNum) => (
            <LazyPdfThumbnail
              key={pageNum}
              pdfUrl={docInfo.pdfUrl}
              pageNumber={pageNum}
              width={100}
              isSelected={pageNum === currentPage}
              onClick={() => goToPage(pageNum)}
            />
          ))}
        </div>

        {/* Page viewer - client-side rendered */}
        <div className="flex-1 overflow-auto p-4">
          <div className="flex justify-center">
            <PdfPageRenderer
              key={`${documentId}-${currentPage}-${scale}`}
              pdfUrl={docInfo.pdfUrl}
              pageNumber={currentPage}
              scale={scale}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
