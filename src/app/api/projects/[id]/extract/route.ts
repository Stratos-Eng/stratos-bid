import { NextRequest, NextResponse } from "next/server"
import { auth } from "@/lib/auth"
import { db } from "@/db"
import { bids, documents, pageText, lineItems } from "@/db/schema"
import { eq, and } from "drizzle-orm"
import { analyzePageText, ExtractedLineItem } from "@/extraction/claude-analyzer"

// Force Node.js runtime for Claude API calls
export const runtime = "nodejs"
export const maxDuration = 300 // 5 minutes for large documents

// POST /api/projects/[id]/extract - Trigger AI extraction (synchronous)
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const { id } = await params

  try {
    // Verify project ownership
    const [project] = await db
      .select()
      .from(bids)
      .where(and(eq(bids.id, id), eq(bids.userId, session.user.id)))
      .limit(1)

    if (!project) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 })
    }

    // Get documents for this project
    const docs = await db
      .select()
      .from(documents)
      .where(eq(documents.bidId, id))

    if (docs.length === 0) {
      return NextResponse.json({ error: "No documents to extract" }, { status: 400 })
    }

    let totalItemsExtracted = 0

    // Process each document synchronously
    for (const doc of docs) {
      // Update status to extracting
      await db
        .update(documents)
        .set({ extractionStatus: "extracting" })
        .where(eq(documents.id, doc.id))

      try {
        // Get stored page text
        const pages = await db
          .select()
          .from(pageText)
          .where(eq(pageText.documentId, doc.id))
          .orderBy(pageText.pageNumber)

        if (pages.length === 0) {
          console.log(`[extract] No text found for document ${doc.id}, skipping`)
          await db
            .update(documents)
            .set({ extractionStatus: "failed" })
            .where(eq(documents.id, doc.id))
          continue
        }

        console.log(`[extract] Processing document ${doc.id} (${pages.length} pages)`)

        // Extract signage from each page with text
        const allItems: Array<ExtractedLineItem & { pageNumber: number }> = []

        for (const page of pages) {
          // Skip pages with no text or flagged as needing OCR
          if (!page.rawText || page.rawText.length < 100) {
            continue
          }

          try {
            const result = await analyzePageText(
              page.rawText,
              page.pageNumber,
              "division_10" // Signage
            )

            for (const item of result.items) {
              allItems.push({ ...item, pageNumber: page.pageNumber })
            }

            console.log(`[extract] Page ${page.pageNumber}: found ${result.items.length} items`)
          } catch (pageError) {
            console.error(`[extract] Error on page ${page.pageNumber}:`, pageError)
            // Continue with other pages
          }
        }

        // Save extracted items to database
        for (const item of allItems) {
          await db.insert(lineItems).values({
            documentId: doc.id,
            bidId: id,
            userId: session.user.id,
            tradeCode: "division_10",
            category: item.category,
            description: item.description,
            estimatedQty: item.estimatedQty,
            unit: item.unit,
            notes: item.notes,
            specifications: item.specifications,
            pageNumber: item.pageNumber,
            pageReference: item.pageReference,
            extractionConfidence: item.confidence,
            extractionModel: "claude-sonnet-4-20250514",
            reviewStatus: "pending",
            extractedAt: new Date(),
          })
        }

        totalItemsExtracted += allItems.length

        // Update document status to completed
        await db
          .update(documents)
          .set({
            extractionStatus: "completed",
            lineItemCount: allItems.length,
          })
          .where(eq(documents.id, doc.id))

        console.log(`[extract] Completed document ${doc.id}: ${allItems.length} items`)
      } catch (docError) {
        console.error(`[extract] Error processing document ${doc.id}:`, docError)
        await db
          .update(documents)
          .set({ extractionStatus: "failed" })
          .where(eq(documents.id, doc.id))
      }
    }

    return NextResponse.json({
      success: true,
      documentsProcessed: docs.length,
      totalItemsExtracted,
    })
  } catch (error) {
    console.error("Extract error:", error)
    return NextResponse.json({ error: "Failed to start extraction" }, { status: 500 })
  }
}
