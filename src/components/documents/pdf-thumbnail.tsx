'use client';

import { useEffect, useRef, useState } from 'react';
import * as pdfjsLib from 'pdfjs-dist';

// Configure worker
if (typeof window !== 'undefined') {
  pdfjsLib.GlobalWorkerOptions.workerSrc = `//cdnjs.cloudflare.com/ajax/libs/pdf.js/${pdfjsLib.version}/pdf.worker.min.mjs`;
}

interface PdfThumbnailProps {
  pdfUrl: string;
  pageNumber: number;
  width?: number;  // Target width in pixels
  className?: string;
  onClick?: () => void;
  isSelected?: boolean;
}

/**
 * Client-side PDF thumbnail renderer using PDF.js
 * Renders a small preview of a PDF page
 */
export function PdfThumbnail({
  pdfUrl,
  pageNumber,
  width = 100,
  className = '',
  onClick,
  isSelected = false,
}: PdfThumbnailProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let pdfDoc: pdfjsLib.PDFDocumentProxy | null = null;

    async function renderThumbnail() {
      if (!canvasRef.current) return;

      try {
        setLoading(true);
        setError(false);

        // Load PDF document
        pdfDoc = await pdfjsLib.getDocument(pdfUrl).promise;

        if (cancelled) return;

        // Get the page
        const page = await pdfDoc.getPage(pageNumber);

        if (cancelled) return;

        // Calculate scale to fit target width
        const originalViewport = page.getViewport({ scale: 1 });
        const scale = width / originalViewport.width;
        const viewport = page.getViewport({ scale });

        // Set canvas dimensions
        const canvas = canvasRef.current;
        const context = canvas.getContext('2d');

        if (!context) return;

        canvas.width = viewport.width;
        canvas.height = viewport.height;

        // Render page
        await page.render({
          canvasContext: context,
          viewport,
          canvas,
        }).promise;

        if (!cancelled) {
          setLoading(false);
        }
      } catch (err) {
        if (cancelled) return;
        console.error('Thumbnail render error:', err);
        setError(true);
        setLoading(false);
      }
    }

    renderThumbnail();

    return () => {
      cancelled = true;
      if (pdfDoc) {
        pdfDoc.destroy();
      }
    };
  }, [pdfUrl, pageNumber, width]);

  return (
    <div
      onClick={onClick}
      className={`
        relative cursor-pointer flex-shrink-0
        transition-all duration-150
        ${isSelected
          ? 'ring-2 ring-blue-500 ring-offset-1 ring-offset-gray-900'
          : 'hover:ring-1 hover:ring-gray-500 hover:ring-offset-1 hover:ring-offset-gray-900'
        }
        rounded overflow-hidden bg-gray-800
        ${className}
      `}
    >
      {loading && (
        <div className="absolute inset-0 flex items-center justify-center bg-gray-700">
          <div className="w-4 h-4 border-2 border-gray-600 border-t-gray-400 rounded-full animate-spin" />
        </div>
      )}

      {error && (
        <div className="absolute inset-0 flex items-center justify-center bg-gray-700 text-gray-400 text-xs">
          Error
        </div>
      )}

      <canvas
        ref={canvasRef}
        className={`bg-white ${loading ? 'invisible' : 'visible'}`}
        style={{ width: '100%', height: 'auto' }}
      />

      {/* Page number badge */}
      <div
        className={`
          absolute bottom-1 right-1
          px-1.5 py-0.5 text-xs rounded
          ${isSelected
            ? 'bg-blue-600 text-white'
            : 'bg-black/60 text-gray-300'
          }
        `}
      >
        {pageNumber}
      </div>
    </div>
  );
}
