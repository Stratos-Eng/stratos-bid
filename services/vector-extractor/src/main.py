"""
Vector Extraction Service

Extracts vector geometry from PDF pages for snapping in the takeoff tool.
"""
from fastapi import FastAPI, HTTPException, BackgroundTasks
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import Optional
import uuid
import base64
import tempfile
import os
import fitz  # PyMuPDF

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

# In-memory job status (replace with Redis in production)
jobs: dict[str, dict] = {}


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


@app.post("/", response_model=SyncExtractionResponse)
async def extract_sync(request: SyncExtractionRequest):
    """
    Synchronous vector extraction - matches Next.js API contract.

    This is the primary endpoint called by /api/takeoff/vectors.
    Accepts base64 PDF data and returns vectors immediately.
    """
    from .extractor import extract_page_vectors

    try:
        # Decode base64 PDF data
        try:
            pdf_bytes = base64.b64decode(request.pdfData)
        except Exception as e:
            return SyncExtractionResponse(
                success=False,
                error=f"Invalid base64 PDF data: {str(e)}"
            )

        # Write to temp file (PyMuPDF needs a file path)
        with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as tmp:
            tmp.write(pdf_bytes)
            tmp_path = tmp.name

        try:
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
        finally:
            # Clean up temp file
            os.unlink(tmp_path)

    except Exception as e:
        return SyncExtractionResponse(
            success=False,
            error=str(e)
        )


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


# === Page Rendering Endpoint ===

class RenderRequest(BaseModel):
    """Request format expected by Next.js /api/takeoff/render endpoint."""
    pdfData: str  # Base64 encoded PDF
    pageNum: int  # 1-indexed page number
    scale: float = 1.5
    returnBase64: bool = True


class RenderResponse(BaseModel):
    """Response format expected by Next.js."""
    success: bool
    image: Optional[str] = None  # Base64 encoded PNG
    width: Optional[int] = None
    height: Optional[int] = None
    error: Optional[str] = None


@app.post("/render", response_model=RenderResponse)
async def render_page(request: RenderRequest):
    """
    Render a PDF page to a PNG image using PyMuPDF.

    This is the endpoint called by /api/takeoff/render.
    Returns a base64-encoded PNG image.
    """
    try:
        # Decode base64 PDF data
        try:
            pdf_bytes = base64.b64decode(request.pdfData)
        except Exception as e:
            return RenderResponse(
                success=False,
                error=f"Invalid base64 PDF data: {str(e)}"
            )

        # Write to temp file (PyMuPDF needs a file path)
        with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as tmp:
            tmp.write(pdf_bytes)
            tmp_path = tmp.name

        try:
            # Open PDF
            doc = fitz.open(tmp_path)

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

            doc.close()
            return result

        finally:
            # Clean up temp file
            os.unlink(tmp_path)

    except Exception as e:
        return RenderResponse(
            success=False,
            error=str(e)
        )


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
    uvicorn.run(app, host="0.0.0.0", port=8001)
