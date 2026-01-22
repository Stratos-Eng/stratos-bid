"""
Vector Extraction Service

Extracts vector geometry from PDF pages for snapping in the takeoff tool.
"""
from fastapi import FastAPI, HTTPException, BackgroundTasks, Request
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import Optional
from contextlib import contextmanager
import uuid
import base64
import tempfile
import os
import gc
import psutil
import time
import hashlib
import shutil
from pathlib import Path
import fitz  # PyMuPDF

# Memory limits - tuned for Render free tier (512MB RAM)
# Stream large PDFs to disk and memory-map them to stay under limit
MAX_PDF_SIZE_MB = 500  # Max PDF size in MB (large construction PDFs)
MAX_PDF_SIZE_BYTES = MAX_PDF_SIZE_MB * 1024 * 1024
MEMORY_THRESHOLD_MB = 250  # Trigger cleanup early on 512MB host
MEMORY_CRITICAL_MB = 400  # Reject requests before hitting 512MB limit

# Lazy-loaded models (declared here to avoid NameError in unload_heavy_models)
_ocr_reader = None
_clip_model = None

# Concurrency limits - separate semaphores for different operation types
# This prevents metadata requests from being blocked by slow renders
import asyncio
_metadata_semaphore = asyncio.Semaphore(3)    # Metadata is fast, allow concurrent
_render_semaphore = asyncio.Semaphore(2)      # Renders need more memory
_extraction_semaphore = asyncio.Semaphore(1)  # Heavy AI extraction stays serialized
# Legacy alias for backwards compatibility
_processing_semaphore = _extraction_semaphore

# PDF cache directory - avoids re-downloading same PDF for multiple page renders
PDF_CACHE_DIR = Path("/tmp/pdf_cache")
PDF_CACHE_DIR.mkdir(exist_ok=True)

app = FastAPI(
    title="Vector Extractor",
    description="PDF vector extraction for takeoff snapping",
    version="0.1.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # Allow all origins for API access
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# In-memory job status with TTL
jobs: dict[str, dict] = {}
JOB_TTL_SECONDS = 3600  # Clean up jobs older than 1 hour


def get_memory_usage_mb() -> float:
    """Get current process memory usage in MB."""
    process = psutil.Process(os.getpid())
    return process.memory_info().rss / 1024 / 1024


def check_memory_critical() -> tuple[bool, float]:
    """Check if memory is at critical level. Returns (is_critical, current_mb)."""
    current = get_memory_usage_mb()
    return current > MEMORY_CRITICAL_MB, current


def cleanup_memory():
    """Force garbage collection and cleanup."""
    gc.collect()


def unload_heavy_models():
    """Unload heavy models to free memory."""
    global _ocr_reader, _clip_model
    if _ocr_reader is not None:
        _ocr_reader = None
        gc.collect()
    if _clip_model is not None:
        _clip_model = None
        gc.collect()


def cleanup_old_jobs():
    """Remove jobs older than TTL."""
    now = time.time()
    expired = [k for k, v in jobs.items() if now - v.get("created_at", 0) > JOB_TTL_SECONDS]
    for k in expired:
        del jobs[k]


# === PDF URL Fetching ===
# NOTE: In-memory PDF caching disabled for 512MB RAM hosts.
# All PDF fetching now streams to temp files for memory efficiency.

async def fetch_pdf_from_url(url: str) -> bytes:
    """
    Fetch PDF from URL into memory. Use only for small PDFs.
    For large PDFs, use fetch_pdf_to_tempfile() instead.
    """
    import httpx

    async with httpx.AsyncClient(timeout=60.0) as client:
        response = await client.get(url)
        response.raise_for_status()
        return response.content


async def fetch_pdf_to_tempfile(url: str) -> str:
    """
    Fetch PDF from URL and save to temp file. Returns temp file path.
    Memory efficient for large PDFs - uses streaming download.
    Caller is responsible for deleting the temp file.
    """
    import httpx

    # Create temp file
    temp_fd, temp_path = tempfile.mkstemp(suffix='.pdf')
    fd_closed = False

    try:
        # Stream download to file to avoid loading into memory
        async with httpx.AsyncClient(timeout=120.0) as client:
            async with client.stream('GET', url) as response:
                response.raise_for_status()
                with os.fdopen(temp_fd, 'wb') as f:
                    fd_closed = True  # fdopen takes ownership, will close on exit
                    async for chunk in response.aiter_bytes(chunk_size=1024 * 1024):  # 1MB chunks
                        f.write(chunk)
        return temp_path
    except Exception:
        # Clean up on error - only close fd if fdopen didn't take ownership
        if not fd_closed:
            os.close(temp_fd)
        if os.path.exists(temp_path):
            os.unlink(temp_path)
        raise


@contextmanager
def open_pdf_from_file(file_path: str):
    """Context manager to open PDF from file path. Memory efficient via memory-mapping."""
    doc = None
    try:
        doc = fitz.open(file_path)  # Memory-mapped, much more efficient
        yield doc
    finally:
        if doc:
            doc.close()


# === PDF Caching ===
# Cache downloaded PDFs to avoid re-downloading for each page render

def get_cached_pdf_path(url: str) -> Path:
    """Get deterministic cache path for a PDF URL."""
    url_hash = hashlib.md5(url.encode()).hexdigest()[:16]
    return PDF_CACHE_DIR / f"{url_hash}.pdf"


async def fetch_pdf_cached(url: str) -> str:
    """
    Fetch PDF to cache if not already there. Returns file path.
    Uses file-based caching to avoid re-downloading the same PDF
    for multiple page renders.
    """
    cache_path = get_cached_pdf_path(url)

    if cache_path.exists():
        # Touch file to update mtime (for LRU cleanup)
        cache_path.touch()
        return str(cache_path)

    # Download to temp first, then move to cache atomically
    temp_path = await fetch_pdf_to_tempfile(url)
    try:
        shutil.move(temp_path, cache_path)
    except Exception:
        # If move fails (e.g., race condition), clean up temp
        if os.path.exists(temp_path):
            os.unlink(temp_path)
        # If cache now exists (another request won), use it
        if cache_path.exists():
            return str(cache_path)
        raise

    return str(cache_path)


def cleanup_pdf_cache(max_age_hours: int = 2, max_size_mb: int = 500):
    """Remove old cached PDFs. Called on startup and periodically."""
    if not PDF_CACHE_DIR.exists():
        return

    cutoff = time.time() - (max_age_hours * 3600)
    total_size = 0
    files_by_age = []

    for f in PDF_CACHE_DIR.glob("*.pdf"):
        try:
            stat = f.stat()
            files_by_age.append((stat.st_mtime, stat.st_size, f))
            total_size += stat.st_size
        except OSError:
            continue

    # Sort oldest first
    files_by_age.sort()

    # Remove old files and files exceeding size limit
    max_size_bytes = max_size_mb * 1024 * 1024
    for mtime, size, f in files_by_age:
        if mtime < cutoff or total_size > max_size_bytes:
            try:
                f.unlink()
                total_size -= size
            except OSError:
                continue


# Clean up cache on startup
cleanup_pdf_cache()


# === Synchronous extraction (matches Next.js API contract) ===

class SyncExtractionRequest(BaseModel):
    """Request format expected by Next.js /api/takeoff/vectors endpoint."""
    pdfData: str  # Base64 encoded PDF
    pageNum: int  # 1-indexed page number
    scale: float = 1.5


class SnapPointResponse(BaseModel):
    type: str  # 'endpoint' | 'midpoint' | 'intersection'
    coords: tuple[float, float]


class LineSegmentResponse(BaseModel):
    start: tuple[float, float]
    end: tuple[float, float]


class SyncExtractionResponse(BaseModel):
    """Response format expected by Next.js."""
    success: bool
    lines: list[dict] = []
    snapPoints: list[dict] = []
    rawPathCount: int = 0
    cleanedPathCount: int = 0
    quality: str = "none"
    error: Optional[str] = None


class SyncExtractionUrlRequest(BaseModel):
    """Request format for URL-based extraction (memory efficient)."""
    pdfUrl: str  # URL to fetch PDF from (Vercel Blob)
    pageNum: int  # 1-indexed page number
    scale: float = 1.5


@app.post("/extract-url", response_model=SyncExtractionResponse)
async def extract_sync_from_url(request: SyncExtractionUrlRequest):
    """
    Synchronous vector extraction via URL.

    Memory-efficient: Streams PDF to temp file then processes.
    """
    from .extractor import extract_page_vectors

    # Validate URL
    if not request.pdfUrl.startswith('https://'):
        return SyncExtractionResponse(success=False, error="pdfUrl must be an HTTPS URL")

    # Check if memory is critical - reject early
    is_critical, mem_mb = check_memory_critical()
    if is_critical:
        cleanup_memory()
        unload_heavy_models()
        # Re-check after cleanup
        is_critical, mem_mb = check_memory_critical()
        if is_critical:
            return SyncExtractionResponse(
                success=False,
                error=f"Server under high memory pressure ({mem_mb:.0f}MB). Please retry in a moment."
            )

    # Use semaphore to limit concurrent PDF processing
    async with _processing_semaphore:
        tmp_path = None
        try:
            # Check memory before processing
            if get_memory_usage_mb() > MEMORY_THRESHOLD_MB:
                cleanup_memory()

            # Stream PDF to temp file (memory efficient)
            try:
                tmp_path = await fetch_pdf_to_tempfile(request.pdfUrl)
            except Exception as e:
                return SyncExtractionResponse(
                    success=False,
                    error=f"Failed to fetch PDF: {str(e)}"
                )

            # Check file size
            file_size = os.path.getsize(tmp_path)
            if file_size > MAX_PDF_SIZE_BYTES:
                return SyncExtractionResponse(
                    success=False,
                    error=f"PDF too large ({file_size / 1024 / 1024:.1f}MB). Max size is {MAX_PDF_SIZE_MB}MB."
                )

            # Extract vectors (extractor uses the file path directly)
            result = extract_page_vectors(
                pdf_path=tmp_path,
                page_number=request.pageNum - 1,  # Convert to 0-indexed
                dpi=request.scale * 72,  # Convert scale to DPI
            )

            return SyncExtractionResponse(
                success=True,
                lines=result["lines"],
                snapPoints=result["snap_points"],
                rawPathCount=result["stats"]["raw_count"],
                cleanedPathCount=result["stats"]["cleaned_count"],
                quality=result["quality"],
            )

        except Exception as e:
            return SyncExtractionResponse(
                success=False,
                error=str(e)
            )
        finally:
            # Always clean up temp file
            if tmp_path and os.path.exists(tmp_path):
                os.unlink(tmp_path)
            cleanup_memory()


@app.post("/", response_model=SyncExtractionResponse)
async def extract_sync(request: SyncExtractionRequest):
    """
    Synchronous vector extraction - matches Next.js API contract.

    This is the primary endpoint called by /api/takeoff/vectors.
    Accepts base64 PDF data and returns vectors immediately.

    @deprecated Use /extract-url for better memory efficiency.
    """
    from .extractor import extract_page_vectors

    # Check if memory is critical - reject early
    is_critical, mem_mb = check_memory_critical()
    if is_critical:
        cleanup_memory()
        unload_heavy_models()
        # Re-check after cleanup
        is_critical, mem_mb = check_memory_critical()
        if is_critical:
            return SyncExtractionResponse(
                success=False,
                error=f"Server under high memory pressure ({mem_mb:.0f}MB). Please retry in a moment."
            )

    # Use semaphore to limit concurrent PDF processing
    async with _processing_semaphore:
        tmp_path = None
        try:
            # Check memory before processing
            if get_memory_usage_mb() > MEMORY_THRESHOLD_MB:
                cleanup_memory()

            # Decode base64 PDF data
            try:
                pdf_bytes = base64.b64decode(request.pdfData)
            except Exception as e:
                return SyncExtractionResponse(
                    success=False,
                    error=f"Invalid base64 PDF data: {str(e)}"
                )

            # Check PDF size
            if len(pdf_bytes) > MAX_PDF_SIZE_BYTES:
                return SyncExtractionResponse(
                    success=False,
                    error=f"PDF too large ({len(pdf_bytes) / 1024 / 1024:.1f}MB). Max size is {MAX_PDF_SIZE_MB}MB."
                )

            # Write to temp file (extractor needs a file path)
            with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as tmp:
                tmp.write(pdf_bytes)
                tmp_path = tmp.name

            # Extract vectors
            result = extract_page_vectors(
                pdf_path=tmp_path,
                page_number=request.pageNum - 1,  # Convert to 0-indexed
                dpi=request.scale * 72,  # Convert scale to DPI
            )

            return SyncExtractionResponse(
                success=True,
                lines=result["lines"],
                snapPoints=result["snap_points"],
                rawPathCount=result["stats"]["raw_count"],
                cleanedPathCount=result["stats"]["cleaned_count"],
                quality=result["quality"],
            )

        except Exception as e:
            return SyncExtractionResponse(
                success=False,
                error=str(e)
            )
        finally:
            # Always clean up temp file
            if tmp_path and os.path.exists(tmp_path):
                os.unlink(tmp_path)
            cleanup_memory()


# === Async extraction (for future use) ===

class ExtractionRequest(BaseModel):
    document_id: str
    page_number: int
    pdf_path: str
    callback_url: str  # Next.js API to receive results


class ExtractionStatus(BaseModel):
    job_id: str
    status: str  # pending, processing, completed, failed
    progress: Optional[float] = None
    error: Optional[str] = None


@app.get("/health")
async def health():
    return {"status": "ok", "service": "vector-extractor"}


# === PDF Metadata Endpoint ===

class MetadataRequest(BaseModel):
    """Request for PDF metadata."""
    pdfUrl: str  # URL to fetch PDF from (Vercel Blob)


class MetadataResponse(BaseModel):
    """Response with PDF metadata."""
    success: bool
    pageCount: int = 0
    width: float = 0  # First page width in points
    height: float = 0  # First page height in points
    title: Optional[str] = None
    author: Optional[str] = None
    error: Optional[str] = None


@app.post("/metadata", response_model=MetadataResponse)
async def get_metadata(request: MetadataRequest):
    """
    Get PDF metadata without loading entire document into Node.js memory.

    Fetches PDF from URL (Vercel Blob) and returns:
    - Page count
    - First page dimensions (width, height in points)
    - Document title and author if available

    Memory-efficient: Streams PDF to temp file then memory-maps it,
    allowing large PDFs on 512MB RAM hosts.
    """
    # Validate URL
    if not request.pdfUrl.startswith('https://'):
        return MetadataResponse(success=False, error="pdfUrl must be an HTTPS URL")

    # Check if memory is critical - reject early
    is_critical, mem_mb = check_memory_critical()
    if is_critical:
        cleanup_memory()
        unload_heavy_models()
        is_critical, mem_mb = check_memory_critical()
        if is_critical:
            return MetadataResponse(
                success=False,
                error=f"Server under high memory pressure ({mem_mb:.0f}MB). Please retry in a moment."
            )

    # Use metadata semaphore - metadata operations are fast
    async with _metadata_semaphore:
        temp_path = None
        try:
            # Check memory before processing
            if get_memory_usage_mb() > MEMORY_THRESHOLD_MB:
                cleanup_memory()

            # Stream PDF to temp file (memory efficient for large files)
            try:
                temp_path = await fetch_pdf_to_tempfile(request.pdfUrl)
            except Exception as e:
                return MetadataResponse(
                    success=False,
                    error=f"Failed to fetch PDF: {str(e)}"
                )

            # Check file size
            file_size = os.path.getsize(temp_path)
            if file_size > MAX_PDF_SIZE_BYTES:
                return MetadataResponse(
                    success=False,
                    error=f"PDF too large ({file_size / 1024 / 1024:.1f}MB). Max size is {MAX_PDF_SIZE_MB}MB."
                )

            # Open PDF from file (memory-mapped, very efficient)
            with open_pdf_from_file(temp_path) as doc:
                # Get first page dimensions
                first_page = doc[0] if len(doc) > 0 else None
                width = first_page.rect.width if first_page else 0
                height = first_page.rect.height if first_page else 0

                # Get document metadata
                metadata = doc.metadata
                title = metadata.get("title") if metadata else None
                author = metadata.get("author") if metadata else None

                return MetadataResponse(
                    success=True,
                    pageCount=len(doc),
                    width=width,
                    height=height,
                    title=title if title else None,
                    author=author if author else None,
                )

        except Exception as e:
            cleanup_memory()
            return MetadataResponse(
                success=False,
                error=str(e)
            )
        finally:
            # Always clean up temp file
            if temp_path and os.path.exists(temp_path):
                os.unlink(temp_path)


# === Pages Info Endpoint ===

class PageInfoItem(BaseModel):
    """Info for a single page."""
    pageNum: int  # 1-indexed
    width: float  # Width in points
    height: float  # Height in points
    rotation: int  # Rotation in degrees


class PagesInfoResponse(BaseModel):
    """Response with info for all pages."""
    success: bool
    pageCount: int = 0
    pages: list[PageInfoItem] = []
    error: Optional[str] = None


@app.post("/pages-info", response_model=PagesInfoResponse)
async def get_pages_info(request: MetadataRequest):
    """
    Get detailed info for all pages of a PDF.

    Returns page count and dimensions for each page.
    Memory-efficient: Streams to temp file then memory-maps.
    """
    # Validate URL
    if not request.pdfUrl.startswith('https://'):
        return PagesInfoResponse(success=False, error="pdfUrl must be an HTTPS URL")

    # Check if memory is critical - reject early
    is_critical, mem_mb = check_memory_critical()
    if is_critical:
        cleanup_memory()
        unload_heavy_models()
        is_critical, mem_mb = check_memory_critical()
        if is_critical:
            return PagesInfoResponse(
                success=False,
                error=f"Server under high memory pressure ({mem_mb:.0f}MB). Please retry in a moment."
            )

    # Use metadata semaphore - page info operations are fast
    async with _metadata_semaphore:
        temp_path = None
        try:
            # Check memory before processing
            if get_memory_usage_mb() > MEMORY_THRESHOLD_MB:
                cleanup_memory()

            # Stream PDF to temp file
            try:
                temp_path = await fetch_pdf_to_tempfile(request.pdfUrl)
            except Exception as e:
                return PagesInfoResponse(
                    success=False,
                    error=f"Failed to fetch PDF: {str(e)}"
                )

            # Check file size
            file_size = os.path.getsize(temp_path)
            if file_size > MAX_PDF_SIZE_BYTES:
                return PagesInfoResponse(
                    success=False,
                    error=f"PDF too large ({file_size / 1024 / 1024:.1f}MB). Max size is {MAX_PDF_SIZE_MB}MB."
                )

            # Open PDF from file (memory-mapped)
            with open_pdf_from_file(temp_path) as doc:
                pages = []
                for i in range(len(doc)):
                    page = doc[i]
                    pages.append(PageInfoItem(
                        pageNum=i + 1,
                        width=page.rect.width,
                        height=page.rect.height,
                        rotation=page.rotation,
                    ))

                return PagesInfoResponse(
                    success=True,
                    pageCount=len(doc),
                    pages=pages,
                )

        except Exception as e:
            cleanup_memory()
            return PagesInfoResponse(
                success=False,
                error=str(e)
            )
        finally:
            if temp_path and os.path.exists(temp_path):
                os.unlink(temp_path)


@app.get("/memory")
async def memory_stats():
    """Get memory usage statistics for debugging."""
    process = psutil.Process(os.getpid())
    mem_info = process.memory_info()
    rss_mb = mem_info.rss / 1024 / 1024

    # Clean up old jobs
    cleanup_old_jobs()

    return {
        "rss_mb": round(rss_mb, 2),
        "vms_mb": round(mem_info.vms / 1024 / 1024, 2),
        "active_jobs": len(jobs),
        "threshold_mb": MEMORY_THRESHOLD_MB,
        "critical_mb": MEMORY_CRITICAL_MB,
        "max_pdf_size_mb": MAX_PDF_SIZE_MB,
        "is_critical": rss_mb > MEMORY_CRITICAL_MB,
        "ocr_loaded": _ocr_reader is not None,
        "clip_loaded": _clip_model is not None,
    }


@app.post("/gc")
async def force_gc():
    """Force garbage collection - useful for debugging memory issues."""
    before_mb = get_memory_usage_mb()
    cleanup_memory()
    cleanup_old_jobs()
    after_mb = get_memory_usage_mb()

    return {
        "before_mb": round(before_mb, 2),
        "after_mb": round(after_mb, 2),
        "freed_mb": round(before_mb - after_mb, 2),
    }


# === Page Rendering Endpoint ===

class RenderRequest(BaseModel):
    """Request for rendering a PDF page."""
    pdfUrl: str  # URL to fetch PDF from (Vercel Blob)
    pageNum: int  # 1-indexed page number
    scale: float = 1.5
    returnBase64: bool = True


class RenderResponse(BaseModel):
    """Response with rendered page."""
    success: bool
    image: Optional[str] = None  # Base64 encoded PNG
    width: Optional[int] = None
    height: Optional[int] = None
    error: Optional[str] = None


@app.post("/render", response_model=RenderResponse)
async def render_page(request: RenderRequest):
    """
    Render a PDF page to a PNG image using PyMuPDF.

    Memory-efficient: Streams PDF to temp file then memory-maps.
    Returns a base64-encoded PNG image.
    """
    # Validate URL
    if not request.pdfUrl.startswith('https://'):
        return RenderResponse(success=False, error="pdfUrl must be an HTTPS URL")

    # Check if memory is critical - reject early
    is_critical, mem_mb = check_memory_critical()
    if is_critical:
        cleanup_memory()
        unload_heavy_models()
        is_critical, mem_mb = check_memory_critical()
        if is_critical:
            return RenderResponse(
                success=False,
                error=f"Server under high memory pressure ({mem_mb:.0f}MB). Please retry in a moment."
            )

    # Use render semaphore - renders need moderate memory
    async with _render_semaphore:
        temp_path = None
        try:
            # Check memory before processing
            if get_memory_usage_mb() > MEMORY_THRESHOLD_MB:
                cleanup_memory()

            # Stream PDF to temp file
            try:
                temp_path = await fetch_pdf_to_tempfile(request.pdfUrl)
            except Exception as e:
                return RenderResponse(
                    success=False,
                    error=f"Failed to fetch PDF: {str(e)}"
                )

            # Check file size
            file_size = os.path.getsize(temp_path)
            if file_size > MAX_PDF_SIZE_BYTES:
                return RenderResponse(
                    success=False,
                    error=f"PDF too large ({file_size / 1024 / 1024:.1f}MB). Max size is {MAX_PDF_SIZE_MB}MB."
                )

            # Open PDF from file (memory-mapped)
            with open_pdf_from_file(temp_path) as doc:
                # Validate page number (1-indexed from API, 0-indexed internally)
                page_index = request.pageNum - 1
                if page_index < 0 or page_index >= len(doc):
                    return RenderResponse(
                        success=False,
                        error=f"Invalid page number. Document has {len(doc)} pages."
                    )

                page = doc[page_index]

                # Calculate matrix for scaling (PDF default is 72 DPI)
                # scale=1.5 means 1.5x the default, so 108 DPI
                mat = fitz.Matrix(request.scale, request.scale)

                # Render page to pixmap (PNG)
                pix = page.get_pixmap(matrix=mat, alpha=False)

                # Convert to PNG bytes
                png_bytes = pix.tobytes("png")

                # Encode as base64
                image_b64 = base64.b64encode(png_bytes).decode("utf-8")

                result = RenderResponse(
                    success=True,
                    image=image_b64,
                    width=pix.width,
                    height=pix.height,
                )

                # Explicitly clear pixmap
                del pix
                del png_bytes

                return result

        except Exception as e:
            cleanup_memory()
            return RenderResponse(
                success=False,
                error=str(e)
            )
        finally:
            if temp_path and os.path.exists(temp_path):
                os.unlink(temp_path)


# === Batch Rendering Endpoint ===

class BatchRenderRequest(BaseModel):
    """Request for rendering multiple pages from a single PDF."""
    pdfUrl: str  # URL to fetch PDF from (Vercel Blob)
    pages: list[int]  # 1-indexed page numbers to render
    scale: float = 0.3  # Thumbnail scale (low res for thumbnails)
    format: str = "webp"  # Output format: webp or png


class BatchRenderResult(BaseModel):
    """Result for a single page render."""
    page: int  # 1-indexed page number
    image: str  # Base64 encoded image
    width: int
    height: int


class BatchRenderResponse(BaseModel):
    """Response with rendered pages."""
    success: bool
    results: list[BatchRenderResult] = []
    failed: list[int] = []  # Page numbers that failed to render
    error: Optional[str] = None


@app.post("/render-batch", response_model=BatchRenderResponse)
async def render_batch(request: BatchRenderRequest):
    """
    Render multiple pages from a single PDF in one request.

    Downloads PDF once (using cache), renders all requested pages.
    Max 20 pages per batch to limit memory/time.

    This is much more efficient than calling /render multiple times
    because:
    1. PDF is downloaded once and cached
    2. Single semaphore acquisition for the batch
    3. PDF document opened once for all pages
    """
    # Validate batch size
    if len(request.pages) > 20:
        return BatchRenderResponse(
            success=False,
            results=[],
            failed=request.pages,
            error="Max 20 pages per batch"
        )

    if len(request.pages) == 0:
        return BatchRenderResponse(success=True, results=[], failed=[])

    # Validate URL
    if not request.pdfUrl.startswith('https://'):
        return BatchRenderResponse(
            success=False,
            results=[],
            failed=request.pages,
            error="pdfUrl must be an HTTPS URL"
        )

    # Check if memory is critical - reject early
    is_critical, mem_mb = check_memory_critical()
    if is_critical:
        cleanup_memory()
        unload_heavy_models()
        is_critical, mem_mb = check_memory_critical()
        if is_critical:
            return BatchRenderResponse(
                success=False,
                results=[],
                failed=request.pages,
                error=f"Server under high memory pressure ({mem_mb:.0f}MB). Please retry."
            )

    # Use render semaphore
    async with _render_semaphore:
        try:
            if get_memory_usage_mb() > MEMORY_THRESHOLD_MB:
                cleanup_memory()

            # Fetch PDF to cache (or use cached version)
            try:
                pdf_path = await fetch_pdf_cached(request.pdfUrl)
            except Exception as e:
                return BatchRenderResponse(
                    success=False,
                    results=[],
                    failed=request.pages,
                    error=f"Failed to fetch PDF: {str(e)}"
                )

            # Check file size
            file_size = os.path.getsize(pdf_path)
            if file_size > MAX_PDF_SIZE_BYTES:
                return BatchRenderResponse(
                    success=False,
                    results=[],
                    failed=request.pages,
                    error=f"PDF too large ({file_size / 1024 / 1024:.1f}MB)"
                )

            results = []
            failed = []

            # Open PDF once for all pages
            with open_pdf_from_file(pdf_path) as doc:
                page_count = len(doc)

                for page_num in request.pages:
                    try:
                        page_idx = page_num - 1
                        if page_idx < 0 or page_idx >= page_count:
                            failed.append(page_num)
                            continue

                        page = doc[page_idx]

                        # Calculate matrix for scaling
                        mat = fitz.Matrix(request.scale, request.scale)

                        # Render page to pixmap
                        pix = page.get_pixmap(matrix=mat, alpha=False)

                        # Convert to requested format
                        if request.format == "webp":
                            import io
                            from PIL import Image
                            img = Image.frombytes("RGB", [pix.width, pix.height], pix.samples)
                            buffer = io.BytesIO()
                            img.save(buffer, format="WEBP", quality=75)
                            image_bytes = buffer.getvalue()
                        else:
                            image_bytes = pix.tobytes("png")

                        image_b64 = base64.b64encode(image_bytes).decode("utf-8")

                        results.append(BatchRenderResult(
                            page=page_num,
                            image=image_b64,
                            width=pix.width,
                            height=pix.height,
                        ))

                        # Clean up pixmap immediately
                        del pix

                    except Exception as e:
                        failed.append(page_num)
                        continue

            return BatchRenderResponse(
                success=True,
                results=results,
                failed=failed,
            )

        except Exception as e:
            cleanup_memory()
            return BatchRenderResponse(
                success=False,
                results=[],
                failed=request.pages,
                error=str(e)
            )
        # Note: Don't delete cached PDF - it may be reused for subsequent batches


# === Tile Rendering Endpoint ===

class TileRequest(BaseModel):
    """Request for rendering a single tile from a PDF page."""
    pdfUrl: str  # URL to fetch PDF from (Vercel Blob)
    pageNum: int  # 1-indexed page number
    z: int  # Zoom level (0-4)
    x: int  # Tile X coordinate
    y: int  # Tile Y coordinate
    tileSize: int = 256  # Output tile size in pixels


class TileResponse(BaseModel):
    """Response with rendered tile."""
    success: bool
    image: Optional[str] = None  # Base64 encoded WebP
    error: Optional[str] = None


@app.post("/tile", response_model=TileResponse)
async def render_tile(request: TileRequest):
    """
    Render a single tile from a PDF page.

    Tiles are 256x256 WebP images. The tile coordinate system:
    - z=0: 1x1 grid (1 tile covers whole page)
    - z=1: 2x2 grid (4 tiles)
    - z=2: 4x4 grid (16 tiles)
    - etc.

    Memory-efficient: Streams PDF to temp file then memory-maps.
    """
    # Validate zoom level
    if request.z < 0 or request.z > 4:
        return TileResponse(success=False, error="Zoom level must be 0-4")

    # Validate URL
    if not request.pdfUrl.startswith('https://'):
        return TileResponse(success=False, error="Invalid PDF URL - must be HTTPS")

    # Check if memory is critical - reject early
    is_critical, mem_mb = check_memory_critical()
    if is_critical:
        cleanup_memory()
        unload_heavy_models()
        is_critical, mem_mb = check_memory_critical()
        if is_critical:
            return TileResponse(
                success=False,
                error=f"Server under high memory pressure ({mem_mb:.0f}MB). Please retry."
            )

    # Use render semaphore - tile rendering needs moderate memory
    async with _render_semaphore:
        temp_path = None
        try:
            if get_memory_usage_mb() > MEMORY_THRESHOLD_MB:
                cleanup_memory()

            # Stream PDF to temp file
            try:
                temp_path = await fetch_pdf_to_tempfile(request.pdfUrl)
            except Exception as e:
                return TileResponse(success=False, error=f"Failed to fetch PDF: {str(e)}")

            file_size = os.path.getsize(temp_path)
            if file_size > MAX_PDF_SIZE_BYTES:
                return TileResponse(
                    success=False,
                    error=f"PDF too large ({file_size / 1024 / 1024:.1f}MB)"
                )

            with open_pdf_from_file(temp_path) as doc:
                page_index = request.pageNum - 1
                if page_index < 0 or page_index >= len(doc):
                    return TileResponse(
                        success=False,
                        error=f"Invalid page number. Document has {len(doc)} pages."
                    )

                page = doc[page_index]
                page_rect = page.rect
                page_width = page_rect.width
                page_height = page_rect.height

                # Calculate tile bounds
                scale = 2 ** request.z  # Number of tiles per dimension
                tile_width = page_width / scale
                tile_height = page_height / scale

                # Validate tile coordinates
                if request.x < 0 or request.x >= scale or request.y < 0 or request.y >= scale:
                    return TileResponse(
                        success=False,
                        error=f"Invalid tile coordinates ({request.x}, {request.y}) for zoom {request.z}"
                    )

                # Calculate clip rectangle for this tile
                clip_x = request.x * tile_width
                clip_y = request.y * tile_height
                clip_rect = fitz.Rect(
                    clip_x,
                    clip_y,
                    min(clip_x + tile_width, page_width),
                    min(clip_y + tile_height, page_height)
                )

                # Calculate matrix to render tile at target size
                # We want the clip region to fill a tileSize x tileSize output
                scale_x = request.tileSize / tile_width
                scale_y = request.tileSize / tile_height
                mat = fitz.Matrix(scale_x, scale_y)

                # Render the tile
                pix = page.get_pixmap(matrix=mat, clip=clip_rect, alpha=False)

                # Convert to WebP for better compression
                import io
                from PIL import Image

                img = Image.frombytes("RGB", [pix.width, pix.height], pix.samples)
                buffer = io.BytesIO()
                img.save(buffer, format="WEBP", quality=85)
                webp_bytes = buffer.getvalue()

                image_b64 = base64.b64encode(webp_bytes).decode("utf-8")

                result = TileResponse(success=True, image=image_b64)

                # Cleanup
                del pix
                del img
                del buffer

                return result

        except Exception as e:
            cleanup_memory()
            return TileResponse(success=False, error=str(e))
        finally:
            if temp_path and os.path.exists(temp_path):
                os.unlink(temp_path)


# === Text Extraction Endpoint ===

class TextExtractionRequest(BaseModel):
    """Request for extracting text from PDF pages."""
    pdfData: str  # Base64 encoded PDF


class PageTextResult(BaseModel):
    """Text extracted from a single page."""
    page: int  # 1-indexed
    text: str
    needsOcr: bool  # True if page has <50 chars (likely scanned)


class TextExtractionResponse(BaseModel):
    """Response with text from all pages."""
    success: bool
    pages: list[PageTextResult] = []
    totalPages: int = 0
    error: Optional[str] = None


class TextExtractionUrlRequest(BaseModel):
    """Request for extracting text from PDF via URL."""
    pdfUrl: str  # URL to fetch PDF from (Vercel Blob)


@app.post("/text-url", response_model=TextExtractionResponse)
async def extract_text_from_url(request: TextExtractionUrlRequest):
    """
    Extract text from all pages of a PDF via URL.

    Memory-efficient: Streams PDF to temp file then memory-maps.
    """
    # Validate URL
    if not request.pdfUrl.startswith('https://'):
        return TextExtractionResponse(success=False, error="pdfUrl must be an HTTPS URL")

    # Check if memory is critical - reject early
    is_critical, mem_mb = check_memory_critical()
    if is_critical:
        cleanup_memory()
        unload_heavy_models()
        is_critical, mem_mb = check_memory_critical()
        if is_critical:
            return TextExtractionResponse(
                success=False,
                error=f"Server under high memory pressure ({mem_mb:.0f}MB). Please retry in a moment."
            )

    # Use semaphore to limit concurrent PDF processing
    async with _processing_semaphore:
        temp_path = None
        try:
            # Check memory before processing
            if get_memory_usage_mb() > MEMORY_THRESHOLD_MB:
                cleanup_memory()

            # Stream PDF to temp file
            try:
                temp_path = await fetch_pdf_to_tempfile(request.pdfUrl)
            except Exception as e:
                return TextExtractionResponse(
                    success=False,
                    error=f"Failed to fetch PDF: {str(e)}"
                )

            # Check file size
            file_size = os.path.getsize(temp_path)
            if file_size > MAX_PDF_SIZE_BYTES:
                return TextExtractionResponse(
                    success=False,
                    error=f"PDF too large ({file_size / 1024 / 1024:.1f}MB). Max size is {MAX_PDF_SIZE_MB}MB."
                )

            # Open PDF from file (memory-mapped)
            with open_pdf_from_file(temp_path) as doc:
                pages = []
                for i in range(len(doc)):
                    page = doc[i]
                    text = page.get_text()

                    # Flag pages with very little text as needing OCR
                    needs_ocr = len(text.strip()) < 50

                    pages.append(PageTextResult(
                        page=i + 1,  # 1-indexed
                        text=text,
                        needsOcr=needs_ocr,
                    ))

                return TextExtractionResponse(
                    success=True,
                    pages=pages,
                    totalPages=len(pages),
                )

        except Exception as e:
            cleanup_memory()
            return TextExtractionResponse(
                success=False,
                error=str(e)
            )
        finally:
            if temp_path and os.path.exists(temp_path):
                os.unlink(temp_path)


@app.post("/text", response_model=TextExtractionResponse)
async def extract_text(request: TextExtractionRequest):
    """
    Extract text from all pages of a PDF.

    Uses PyMuPDF's text extraction which works well for PDFs with
    embedded text (CAD exports, digital documents). Pages with very
    little text (<50 chars) are flagged as needing OCR.

    @deprecated Use /text-url for better memory efficiency.
    """
    # Check if memory is critical - reject early
    is_critical, mem_mb = check_memory_critical()
    if is_critical:
        cleanup_memory()
        unload_heavy_models()
        is_critical, mem_mb = check_memory_critical()
        if is_critical:
            return TextExtractionResponse(
                success=False,
                error=f"Server under high memory pressure ({mem_mb:.0f}MB). Please retry in a moment."
            )

    # Use semaphore to limit concurrent PDF processing
    async with _processing_semaphore:
        temp_path = None
        try:
            # Check memory before processing
            if get_memory_usage_mb() > MEMORY_THRESHOLD_MB:
                cleanup_memory()

            # Decode base64 PDF data
            try:
                pdf_bytes = base64.b64decode(request.pdfData)
            except Exception as e:
                return TextExtractionResponse(
                    success=False,
                    error=f"Invalid base64 PDF data: {str(e)}"
                )

            # Check PDF size
            if len(pdf_bytes) > MAX_PDF_SIZE_BYTES:
                return TextExtractionResponse(
                    success=False,
                    error=f"PDF too large ({len(pdf_bytes) / 1024 / 1024:.1f}MB). Max size is {MAX_PDF_SIZE_MB}MB."
                )

            # Write to temp file for memory-efficient processing
            with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as tmp:
                tmp.write(pdf_bytes)
                temp_path = tmp.name

            # Clear pdf_bytes from memory immediately
            del pdf_bytes

            # Open from file (memory-mapped)
            with open_pdf_from_file(temp_path) as doc:
                pages = []
                for i in range(len(doc)):
                    page = doc[i]
                    text = page.get_text()

                    # Flag pages with very little text as needing OCR
                    needs_ocr = len(text.strip()) < 50

                    pages.append(PageTextResult(
                        page=i + 1,  # 1-indexed
                        text=text,
                        needsOcr=needs_ocr,
                    ))

                return TextExtractionResponse(
                    success=True,
                    pages=pages,
                    totalPages=len(pages),
                )

        except Exception as e:
            cleanup_memory()
            return TextExtractionResponse(
                success=False,
                error=str(e)
            )
        finally:
            if temp_path and os.path.exists(temp_path):
                os.unlink(temp_path)


# === Region Crop Endpoint ===

class CropRequest(BaseModel):
    """Request for cropping a region from a PDF page."""
    pdfData: str  # Base64 encoded PDF
    pageNum: int  # 1-indexed page number
    x: float      # Center X coordinate (normalized 0-1)
    y: float      # Center Y coordinate (normalized 0-1)
    width: float = 100   # Width in pixels at 150 DPI
    height: float = 100  # Height in pixels at 150 DPI


class CropResponse(BaseModel):
    """Response with cropped region as base64 PNG."""
    success: bool
    image: Optional[str] = None  # Base64 encoded PNG
    width: Optional[int] = None
    height: Optional[int] = None
    error: Optional[str] = None


class CropUrlRequest(BaseModel):
    """Request for cropping a region from a PDF page via URL."""
    pdfUrl: str   # URL to fetch PDF from (Vercel Blob)
    pageNum: int  # 1-indexed page number
    x: float      # Center X coordinate (normalized 0-1)
    y: float      # Center Y coordinate (normalized 0-1)
    width: float = 100   # Width in pixels at 150 DPI
    height: float = 100  # Height in pixels at 150 DPI


@app.post("/crop-url", response_model=CropResponse)
async def crop_region_from_url(request: CropUrlRequest):
    """
    Crop a region from a PDF page via URL.

    Input coordinates are normalized (0-1), output is a base64 PNG.
    Memory-efficient: Streams PDF to temp file then memory-maps.
    """
    # Validate URL
    if not request.pdfUrl.startswith('https://'):
        return CropResponse(success=False, error="pdfUrl must be an HTTPS URL")

    # Check if memory is critical - reject early
    is_critical, mem_mb = check_memory_critical()
    if is_critical:
        cleanup_memory()
        unload_heavy_models()
        is_critical, mem_mb = check_memory_critical()
        if is_critical:
            return CropResponse(
                success=False,
                error=f"Server under high memory pressure ({mem_mb:.0f}MB). Please retry in a moment."
            )

    # Use render semaphore - cropping is a render operation
    async with _render_semaphore:
        temp_path = None
        try:
            # Check memory before processing
            if get_memory_usage_mb() > MEMORY_THRESHOLD_MB:
                cleanup_memory()

            # Stream PDF to temp file
            try:
                temp_path = await fetch_pdf_to_tempfile(request.pdfUrl)
            except Exception as e:
                return CropResponse(success=False, error=f"Failed to fetch PDF: {str(e)}")

            # Check file size
            file_size = os.path.getsize(temp_path)
            if file_size > MAX_PDF_SIZE_BYTES:
                return CropResponse(
                    success=False,
                    error=f"PDF too large ({file_size / 1024 / 1024:.1f}MB). Max size is {MAX_PDF_SIZE_MB}MB."
                )

            # Open PDF from file (memory-mapped)
            with open_pdf_from_file(temp_path) as doc:
                # Validate page number
                page_index = request.pageNum - 1
                if page_index < 0 or page_index >= len(doc):
                    return CropResponse(
                        success=False,
                        error=f"Invalid page number. Document has {len(doc)} pages."
                    )

                page = doc[page_index]

                # Get page dimensions
                page_rect = page.rect
                page_width = page_rect.width
                page_height = page_rect.height

                # Convert normalized coordinates to page coordinates
                center_x = request.x * page_width
                center_y = request.y * page_height

                # Calculate crop rectangle (in PDF points)
                dpi_scale = 72 / 150
                half_width = (request.width / 2) * dpi_scale
                half_height = (request.height / 2) * dpi_scale

                # Create clip rectangle
                clip_rect = fitz.Rect(
                    max(0, center_x - half_width),
                    max(0, center_y - half_height),
                    min(page_width, center_x + half_width),
                    min(page_height, center_y + half_height)
                )

                # Render the cropped region at 150 DPI
                mat = fitz.Matrix(150 / 72, 150 / 72)
                pix = page.get_pixmap(matrix=mat, clip=clip_rect, alpha=False)

                # Convert to PNG bytes
                png_bytes = pix.tobytes("png")
                image_b64 = base64.b64encode(png_bytes).decode("utf-8")

                result = CropResponse(
                    success=True,
                    image=image_b64,
                    width=pix.width,
                    height=pix.height,
                )

                del pix
                del png_bytes

                return result

        except Exception as e:
            cleanup_memory()
            return CropResponse(success=False, error=str(e))
        finally:
            if temp_path and os.path.exists(temp_path):
                os.unlink(temp_path)


@app.post("/crop", response_model=CropResponse)
async def crop_region(request: CropRequest):
    """
    Crop a region from a PDF page around the specified coordinates.

    Input coordinates are normalized (0-1), output is a base64 PNG.

    @deprecated Use /crop-url for better memory efficiency.
    """
    # Check if memory is critical - reject early
    is_critical, mem_mb = check_memory_critical()
    if is_critical:
        cleanup_memory()
        unload_heavy_models()
        is_critical, mem_mb = check_memory_critical()
        if is_critical:
            return CropResponse(
                success=False,
                error=f"Server under high memory pressure ({mem_mb:.0f}MB). Please retry in a moment."
            )

    # Use render semaphore - cropping is a render operation
    async with _render_semaphore:
        temp_path = None
        try:
            # Check memory before processing
            if get_memory_usage_mb() > MEMORY_THRESHOLD_MB:
                cleanup_memory()

            # Decode base64 PDF data
            try:
                pdf_bytes = base64.b64decode(request.pdfData)
            except Exception as e:
                return CropResponse(success=False, error=f"Invalid base64 PDF data: {str(e)}")

            # Check PDF size
            if len(pdf_bytes) > MAX_PDF_SIZE_BYTES:
                return CropResponse(
                    success=False,
                    error=f"PDF too large ({len(pdf_bytes) / 1024 / 1024:.1f}MB). Max size is {MAX_PDF_SIZE_MB}MB."
                )

            # Write to temp file for memory-efficient processing
            with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as tmp:
                tmp.write(pdf_bytes)
                temp_path = tmp.name

            # Clear pdf_bytes from memory immediately
            del pdf_bytes

            # Open from file (memory-mapped)
            with open_pdf_from_file(temp_path) as doc:
                # Validate page number
                page_index = request.pageNum - 1
                if page_index < 0 or page_index >= len(doc):
                    return CropResponse(
                        success=False,
                        error=f"Invalid page number. Document has {len(doc)} pages."
                    )

                page = doc[page_index]

                # Get page dimensions
                page_rect = page.rect
                page_width = page_rect.width
                page_height = page_rect.height

                # Convert normalized coordinates to page coordinates
                center_x = request.x * page_width
                center_y = request.y * page_height

                # Calculate crop rectangle (in PDF points)
                dpi_scale = 72 / 150
                half_width = (request.width / 2) * dpi_scale
                half_height = (request.height / 2) * dpi_scale

                # Create clip rectangle
                clip_rect = fitz.Rect(
                    max(0, center_x - half_width),
                    max(0, center_y - half_height),
                    min(page_width, center_x + half_width),
                    min(page_height, center_y + half_height)
                )

                # Render the cropped region at 150 DPI
                mat = fitz.Matrix(150 / 72, 150 / 72)
                pix = page.get_pixmap(matrix=mat, clip=clip_rect, alpha=False)

                # Convert to PNG bytes
                png_bytes = pix.tobytes("png")
                image_b64 = base64.b64encode(png_bytes).decode("utf-8")

                result = CropResponse(
                    success=True,
                    image=image_b64,
                    width=pix.width,
                    height=pix.height,
                )

                del pix
                del png_bytes

                return result

        except Exception as e:
            cleanup_memory()
            return CropResponse(success=False, error=str(e))
        finally:
            if temp_path and os.path.exists(temp_path):
                os.unlink(temp_path)


# === OCR Endpoint ===

def get_ocr_reader():
    global _ocr_reader
    if _ocr_reader is None:
        import easyocr
        _ocr_reader = easyocr.Reader(['en'], gpu=False)
    return _ocr_reader


class OcrRequest(BaseModel):
    """Request for OCR on an image."""
    image: str  # Base64 encoded PNG


class OcrResponse(BaseModel):
    """Response with OCR results."""
    success: bool
    text: Optional[str] = None
    confidence: Optional[float] = None
    boxes: list = []  # List of detected text boxes
    error: Optional[str] = None


@app.post("/ocr", response_model=OcrResponse)
async def ocr_image(request: OcrRequest):
    """
    Perform OCR on a base64-encoded image.

    Returns detected text and confidence score.
    """
    # Check if memory is critical - reject early (OCR loads ~200MB model)
    is_critical, mem_mb = check_memory_critical()
    if is_critical:
        cleanup_memory()
        # Don't unload OCR model here since we're about to use it
        is_critical, mem_mb = check_memory_critical()
        if is_critical:
            return OcrResponse(
                success=False,
                error=f"Server under high memory pressure ({mem_mb:.0f}MB). Please retry in a moment."
            )

    # Use semaphore to limit concurrent processing
    async with _processing_semaphore:
        try:
            import io
            from PIL import Image
            import numpy as np

            # Decode base64 image
            try:
                image_bytes = base64.b64decode(request.image)
                image = Image.open(io.BytesIO(image_bytes))
                image_array = np.array(image)
            except Exception as e:
                return OcrResponse(success=False, error=f"Invalid image data: {str(e)}")

            # Get OCR reader
            reader = get_ocr_reader()

            # Perform OCR
            results = reader.readtext(image_array)

            if not results:
                return OcrResponse(
                    success=True,
                    text="",
                    confidence=0.0,
                    boxes=[],
                )

            # Combine all text and calculate average confidence
            texts = []
            confidences = []
            boxes = []

            for (bbox, text, conf) in results:
                texts.append(text)
                confidences.append(conf)
                boxes.append({
                    "text": text,
                    "confidence": conf,
                    "bbox": bbox,
                })

            combined_text = " ".join(texts)
            avg_confidence = sum(confidences) / len(confidences) if confidences else 0.0

            return OcrResponse(
                success=True,
                text=combined_text,
                confidence=avg_confidence,
                boxes=boxes,
            )

        except Exception as e:
            return OcrResponse(success=False, error=str(e))


# === CLIP Embedding Endpoint ===

def get_clip_model():
    global _clip_model
    if _clip_model is None:
        from sentence_transformers import SentenceTransformer
        # Use a small, fast CLIP model
        _clip_model = SentenceTransformer('clip-ViT-B-32')
    return _clip_model


class EmbedRequest(BaseModel):
    """Request for generating image embedding."""
    image: str  # Base64 encoded PNG


class EmbedResponse(BaseModel):
    """Response with image embedding."""
    success: bool
    embedding: Optional[list] = None  # 512-dim float array
    error: Optional[str] = None


@app.post("/embed", response_model=EmbedResponse)
async def generate_embedding(request: EmbedRequest):
    """
    Generate a CLIP embedding for a base64-encoded image.

    Returns a 512-dimensional float vector for similarity search.
    """
    # Check if memory is critical - reject early (CLIP loads ~400MB model)
    is_critical, mem_mb = check_memory_critical()
    if is_critical:
        cleanup_memory()
        # Don't unload CLIP model here since we're about to use it
        is_critical, mem_mb = check_memory_critical()
        if is_critical:
            return EmbedResponse(
                success=False,
                error=f"Server under high memory pressure ({mem_mb:.0f}MB). Please retry in a moment."
            )

    # Use semaphore to limit concurrent processing
    async with _processing_semaphore:
        try:
            import io
            from PIL import Image

            # Decode base64 image
            try:
                image_bytes = base64.b64decode(request.image)
                image = Image.open(io.BytesIO(image_bytes))
                # Convert to RGB if necessary
                if image.mode != 'RGB':
                    image = image.convert('RGB')
            except Exception as e:
                return EmbedResponse(success=False, error=f"Invalid image data: {str(e)}")

            # Get CLIP model
            model = get_clip_model()

            # Generate embedding
            embedding = model.encode(image)

            # Convert to list of floats
            embedding_list = embedding.tolist()

            return EmbedResponse(
                success=True,
                embedding=embedding_list,
            )

        except Exception as e:
            return EmbedResponse(success=False, error=str(e))


@app.post("/extract", response_model=ExtractionStatus)
async def extract_vectors(request: ExtractionRequest, background_tasks: BackgroundTasks):
    """
    Queue vector extraction for a PDF page.
    Returns immediately with job_id for status polling.
    """
    job_id = str(uuid.uuid4())
    jobs[job_id] = {
        "status": "pending",
        "progress": 0,
        "request": request.model_dump(),
    }

    # Queue background extraction
    background_tasks.add_task(run_extraction, job_id, request)

    return ExtractionStatus(job_id=job_id, status="pending", progress=0)


@app.get("/status/{job_id}", response_model=ExtractionStatus)
async def get_status(job_id: str):
    """Get extraction job status."""
    if job_id not in jobs:
        raise HTTPException(status_code=404, detail="Job not found")

    job = jobs[job_id]
    return ExtractionStatus(
        job_id=job_id,
        status=job["status"],
        progress=job.get("progress"),
        error=job.get("error"),
    )


async def run_extraction(job_id: str, request: ExtractionRequest):
    """Background task to extract vectors."""
    # Import here to avoid startup delay
    from .extractor import extract_page_vectors
    import httpx

    jobs[job_id]["status"] = "processing"
    jobs[job_id]["progress"] = 0.1

    try:
        # Extract vectors
        result = extract_page_vectors(
            pdf_path=request.pdf_path,
            page_number=request.page_number,
            on_progress=lambda p: jobs[job_id].update({"progress": p}),
        )

        jobs[job_id]["progress"] = 0.9

        # Send results to callback URL
        async with httpx.AsyncClient() as client:
            await client.post(
                request.callback_url,
                json={
                    "document_id": request.document_id,
                    "page_number": request.page_number,
                    "vectors": result,
                },
                timeout=30.0,
            )

        jobs[job_id]["status"] = "completed"
        jobs[job_id]["progress"] = 1.0

    except Exception as e:
        jobs[job_id]["status"] = "failed"
        jobs[job_id]["error"] = str(e)


if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("PORT", 8001))
    uvicorn.run(app, host="0.0.0.0", port=port)
