"""
PDF page rendering using PyMuPDF (fitz).
Deployed as a Vercel Python serverless function.

Renders PDF pages to PNG images for display in the takeoff viewer.
"""

from http.server import BaseHTTPRequestHandler
import json
import base64
import tempfile
import os

try:
    import fitz  # PyMuPDF
except ImportError:
    fitz = None


class handler(BaseHTTPRequestHandler):
    """Vercel serverless function handler."""

    def do_POST(self):
        """Handle POST request with PDF data."""
        if fitz is None:
            self.send_response(500)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(
                json.dumps({"error": "PyMuPDF not installed"}).encode()
            )
            return

        try:
            # Read request body
            content_length = int(self.headers.get("Content-Length", 0))
            body = self.rfile.read(content_length)
            data = json.loads(body)

            # Get parameters
            pdf_base64 = data.get("pdfData")
            page_num = data.get("pageNum", 1)
            scale = data.get("scale", 1.5)
            return_base64 = data.get("returnBase64", True)

            if not pdf_base64:
                self.send_response(400)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(
                    json.dumps({"error": "pdfData is required"}).encode()
                )
                return

            # Decode PDF data
            pdf_bytes = base64.b64decode(pdf_base64)

            # Write to temp file (PyMuPDF works better with files)
            with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as f:
                f.write(pdf_bytes)
                temp_path = f.name

            try:
                # Open PDF
                doc = fitz.open(temp_path)

                if page_num < 1 or page_num > len(doc):
                    self.send_response(400)
                    self.send_header("Content-Type", "application/json")
                    self.end_headers()
                    self.wfile.write(
                        json.dumps(
                            {"error": f"Invalid page number. Document has {len(doc)} pages."}
                        ).encode()
                    )
                    return

                # Get page (0-indexed)
                page = doc[page_num - 1]

                # Create transformation matrix for scaling
                mat = fitz.Matrix(scale, scale)

                # Render page to pixmap (PNG)
                pix = page.get_pixmap(matrix=mat, alpha=False)

                # Get PNG bytes
                png_bytes = pix.tobytes("png")

                # Get dimensions
                width = pix.width
                height = pix.height

                doc.close()

            finally:
                # Clean up temp file
                os.unlink(temp_path)

            if return_base64:
                # Return as JSON with base64-encoded image
                response = {
                    "success": True,
                    "width": width,
                    "height": height,
                    "pageCount": len(doc) if 'doc' in dir() else 1,
                    "image": base64.b64encode(png_bytes).decode("utf-8"),
                    "contentType": "image/png",
                }
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps(response).encode())
            else:
                # Return raw PNG image
                self.send_response(200)
                self.send_header("Content-Type", "image/png")
                self.send_header("Content-Length", str(len(png_bytes)))
                self.send_header("X-Image-Width", str(width))
                self.send_header("X-Image-Height", str(height))
                self.end_headers()
                self.wfile.write(png_bytes)

        except Exception as e:
            self.send_response(500)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(
                json.dumps({"error": str(e)}).encode()
            )

    def do_GET(self):
        """Health check endpoint."""
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(
            json.dumps({
                "status": "ok",
                "pymupdf_available": fitz is not None,
                "version": fitz.version if fitz else None,
            }).encode()
        )
