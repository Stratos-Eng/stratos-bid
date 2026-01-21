import { NextRequest, NextResponse } from "next/server"
import { auth } from "@/lib/auth"
import { db } from "@/db"
import { bids, documents } from "@/db/schema"
import { eq, and } from "drizzle-orm"
import { inngest } from "@/inngest/client"

// POST /api/projects/[id]/extract - Trigger AI extraction
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

    // Update documents to queued status
    for (const doc of docs) {
      await db
        .update(documents)
        .set({ extractionStatus: "queued" })
        .where(eq(documents.id, doc.id))
    }

    // Trigger extraction and thumbnail generation via Inngest for each document
    for (const doc of docs) {
      // Queue extraction
      await inngest.send({
        name: "extraction/signage",
        data: {
          documentId: doc.id,
          bidId: id,
          userId: session.user.id,
        },
      })

      // Queue thumbnail generation (runs in parallel)
      await inngest.send({
        name: "document/generate-thumbnails",
        data: {
          documentId: doc.id,
        },
      })
    }

    return NextResponse.json({
      success: true,
      documentsQueued: docs.length,
    })
  } catch (error) {
    console.error("Extract error:", error)
    return NextResponse.json({ error: "Failed to start extraction" }, { status: 500 })
  }
}
