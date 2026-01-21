FROM python:3.11-slim

# Set working directory
WORKDIR /app

# Install system dependencies for PyMuPDF and EasyOCR
RUN apt-get update && apt-get install -y --no-install-recommends \
    libgl1 \
    libglib2.0-0 \
    libsm6 \
    libxext6 \
    libxrender1 \
    libgomp1 \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Copy dependency files
COPY pyproject.toml .

# Install Python dependencies
RUN pip install --no-cache-dir .

# Create cache directory for models
RUN mkdir -p /root/.cache/torch/hub /root/.EasyOCR

# Copy application code
COPY src/ src/

# Pre-download CLIP model during build (optional but speeds up cold starts)
# Uncomment if you want models baked into the image (increases image size by ~500MB)
# RUN python -c "from sentence_transformers import SentenceTransformer; SentenceTransformer('clip-ViT-B-32')"

# Expose port (Render uses PORT env var, default 10000)
EXPOSE 10000

# Health check using PORT env var
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
    CMD curl -f http://localhost:${PORT:-10000}/health || exit 1

# Run the application - use shell form to expand PORT env var
CMD uvicorn src.main:app --host 0.0.0.0 --port ${PORT:-10000}
