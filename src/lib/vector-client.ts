// src/lib/vector-client.ts
/**
 * Client for the Python vector extraction service.
 */

const VECTOR_SERVICE_URL = process.env.VECTOR_SERVICE_URL || "http://localhost:8001";

interface ExtractionRequest {
  documentId: string;
  pageNumber: number;
  pdfPath: string;
}

interface ExtractionStatus {
  job_id: string;
  status: "pending" | "processing" | "completed" | "failed";
  progress?: number;
  error?: string;
}

export async function triggerVectorExtraction(
  request: ExtractionRequest
): Promise<ExtractionStatus> {
  const callbackUrl = `${process.env.NEXTAUTH_URL || "http://localhost:3000"}/api/vectors`;

  const response = await fetch(`${VECTOR_SERVICE_URL}/extract`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      document_id: request.documentId,
      page_number: request.pageNumber,
      pdf_path: request.pdfPath,
      callback_url: callbackUrl,
    }),
  });

  if (!response.ok) {
    throw new Error(`Vector extraction failed: ${response.statusText}`);
  }

  return response.json();
}

export async function getExtractionStatus(jobId: string): Promise<ExtractionStatus> {
  const response = await fetch(`${VECTOR_SERVICE_URL}/status/${jobId}`);

  if (!response.ok) {
    throw new Error(`Failed to get extraction status: ${response.statusText}`);
  }

  return response.json();
}

export async function extractAllPages(
  documentId: string,
  pdfPath: string,
  pageCount: number
): Promise<string[]> {
  const jobIds: string[] = [];

  for (let page = 0; page < pageCount; page++) {
    try {
      const result = await triggerVectorExtraction({
        documentId,
        pageNumber: page,
        pdfPath,
      });
      jobIds.push(result.job_id);
    } catch (error) {
      console.error(`Failed to trigger extraction for page ${page}:`, error);
    }
  }

  return jobIds;
}
