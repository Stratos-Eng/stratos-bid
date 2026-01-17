# Vector Extractor Service

PDF vector extraction service for the Stratos takeoff tool. Uses PyMuPDF to extract vector geometry from PDFs for precision snapping.

## Features

- Extracts line segments, rectangles, and curves from PDF pages
- Cleans and merges collinear line segments
- Generates snap points (endpoints, midpoints, intersections)
- Quality assessment for extracted vectors

## Setup

```bash
# Create virtual environment OUTSIDE the project (to avoid Turbopack issues)
cd services/vector-extractor
python3 -m venv ~/stratos/vector-extractor-venv

# Activate and install dependencies
source ~/stratos/vector-extractor-venv/bin/activate
pip install -e .
pip install pytest  # for tests
```

## Running

```bash
# Activate venv
source ~/stratos/vector-extractor-venv/bin/activate

# Start the service
uvicorn src.main:app --host 0.0.0.0 --port 8001

# Or run directly
python -m src.main
```

## API

### POST / - Synchronous Vector Extraction

Primary endpoint called by Next.js `/api/takeoff/vectors`.

**Request:**
```json
{
  "pdfData": "<base64 encoded PDF>",
  "pageNum": 1,
  "scale": 1.5
}
```

**Response:**
```json
{
  "success": true,
  "lines": [{"start": [x, y], "end": [x, y], "width": 1.5}],
  "snapPoints": [{"type": "endpoint", "coords": [x, y]}],
  "rawPathCount": 5243,
  "cleanedPathCount": 433,
  "quality": "good"
}
```

### GET /health - Health Check

```json
{"status": "ok", "service": "vector-extractor"}
```

## Configuration

Set `PYTHON_VECTOR_API_URL=http://localhost:8001` in `.env.local` to enable Python extraction in the Next.js app.

## Testing

```bash
source ~/stratos/vector-extractor-venv/bin/activate
cd services/vector-extractor
python -m pytest tests/ -v
```

## Architecture

```
src/
├── main.py       # FastAPI app with endpoints
├── extractor.py  # Core extraction logic using PyMuPDF
└── geometry.py   # Geometry utilities (distance, intersection, etc.)
```

The service is stateless and can be horizontally scaled. Each request is processed synchronously - for large PDFs, consider adjusting timeouts.
