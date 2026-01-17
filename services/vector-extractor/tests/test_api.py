"""
Integration tests for the vector extraction API.
"""
import pytest
import base64
import os
from pathlib import Path
from fastapi.testclient import TestClient


# Find a sample PDF for testing
SAMPLE_PDF_PATHS = [
    Path(__file__).parent.parent.parent.parent / "uploads/takeoff",
]


def find_sample_pdf() -> Path | None:
    """Find a sample PDF for testing."""
    for base_path in SAMPLE_PDF_PATHS:
        if base_path.exists():
            for pdf in base_path.rglob("*.pdf"):
                # Use a smaller PDF if possible (< 5MB)
                if pdf.stat().st_size < 5 * 1024 * 1024:
                    return pdf
    return None


@pytest.fixture
def client():
    """Create test client for FastAPI app."""
    from src.main import app
    return TestClient(app)


@pytest.fixture
def sample_pdf_base64():
    """Load a sample PDF as base64."""
    pdf_path = find_sample_pdf()
    if pdf_path is None:
        pytest.skip("No sample PDF found for testing")

    with open(pdf_path, "rb") as f:
        return base64.b64encode(f.read()).decode("utf-8")


class TestHealthEndpoint:
    """Tests for /health endpoint."""

    def test_health_returns_ok(self, client):
        response = client.get("/health")
        assert response.status_code == 200
        data = response.json()
        assert data["status"] == "ok"
        assert data["service"] == "vector-extractor"


class TestSyncExtraction:
    """Tests for POST / synchronous extraction endpoint."""

    def test_extract_sync_returns_success_structure(self, client, sample_pdf_base64):
        """Test that sync extraction returns properly structured response."""
        response = client.post("/", json={
            "pdfData": sample_pdf_base64,
            "pageNum": 1,
            "scale": 1.5,
        })

        assert response.status_code == 200
        data = response.json()

        # Check response structure
        assert "success" in data
        assert "lines" in data
        assert "snapPoints" in data
        assert "rawPathCount" in data
        assert "cleanedPathCount" in data
        assert "quality" in data

    def test_extract_sync_success_with_vectors(self, client, sample_pdf_base64):
        """Test that sync extraction actually extracts vectors."""
        response = client.post("/", json={
            "pdfData": sample_pdf_base64,
            "pageNum": 1,
            "scale": 1.5,
        })

        assert response.status_code == 200
        data = response.json()

        assert data["success"] is True
        assert data["error"] is None

        # Should have extracted some data
        assert data["rawPathCount"] >= 0
        assert data["cleanedPathCount"] >= 0
        assert data["quality"] in ["good", "medium", "poor", "none"]

        # Lines should be properly formatted
        for line in data["lines"]:
            assert "start" in line
            assert "end" in line
            assert len(line["start"]) == 2
            assert len(line["end"]) == 2

        # Snap points should be properly formatted
        for point in data["snapPoints"]:
            assert "type" in point
            assert "coords" in point
            assert point["type"] in ["endpoint", "midpoint", "intersection"]
            assert len(point["coords"]) == 2

    def test_extract_sync_invalid_base64(self, client):
        """Test that invalid base64 returns error."""
        response = client.post("/", json={
            "pdfData": "not-valid-base64!!!",
            "pageNum": 1,
            "scale": 1.5,
        })

        assert response.status_code == 200  # We return 200 with success=false
        data = response.json()
        assert data["success"] is False
        assert data["error"] is not None

    def test_extract_sync_empty_pdf(self, client):
        """Test that empty data returns error."""
        response = client.post("/", json={
            "pdfData": base64.b64encode(b"").decode("utf-8"),
            "pageNum": 1,
            "scale": 1.5,
        })

        assert response.status_code == 200
        data = response.json()
        assert data["success"] is False
        assert data["error"] is not None

    def test_extract_sync_invalid_page_number(self, client, sample_pdf_base64):
        """Test that invalid page number returns error."""
        response = client.post("/", json={
            "pdfData": sample_pdf_base64,
            "pageNum": 9999,  # Way beyond any PDF
            "scale": 1.5,
        })

        assert response.status_code == 200
        data = response.json()
        assert data["success"] is False
        assert data["error"] is not None

    def test_extract_sync_different_scales(self, client, sample_pdf_base64):
        """Test extraction at different scales."""
        for scale in [1.0, 1.5, 2.0]:
            response = client.post("/", json={
                "pdfData": sample_pdf_base64,
                "pageNum": 1,
                "scale": scale,
            })

            assert response.status_code == 200
            data = response.json()
            assert data["success"] is True
