"""
Vector Extraction Service

Extracts vector geometry from PDF pages for snapping in the takeoff tool.
"""
from fastapi import FastAPI, HTTPException, BackgroundTasks
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import Optional
import uuid

app = FastAPI(
    title="Vector Extractor",
    description="PDF vector extraction for takeoff snapping",
    version="0.1.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# In-memory job status (replace with Redis in production)
jobs: dict[str, dict] = {}


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
