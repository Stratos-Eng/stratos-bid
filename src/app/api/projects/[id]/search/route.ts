import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { db } from '@/db';
import { documents, bids } from '@/db/schema';
import { eq, sql } from 'drizzle-orm';

interface SearchResult {
  documentId: string;
  documentName: string;
  pageNumber: number;
  snippet: string;
  rank: number;
}

interface SearchResponse {
  query: string;
  total: number;
  results: SearchResult[];
  indexingStatus: {
    totalPages: number;
    indexedPages: number;
    pagesNeedingOcr: number;
  };
}

// GET /api/projects/[id]/search?q=<query>
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { id: projectId } = await params;
    const { searchParams } = new URL(request.url);
    const query = searchParams.get('q');

    if (!query || query.trim().length === 0) {
      return NextResponse.json({ error: 'Query required' }, { status: 400 });
    }

    // Verify user has access to this project (via bid ownership)
    const [bid] = await db
      .select()
      .from(bids)
      .where(eq(bids.id, projectId))
      .limit(1);

    if (!bid || bid.userId !== session.user.id) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 });
    }

    // Get indexing status (separate queries to avoid join multiplication)
    const indexingStatus = await db.execute(sql`
      SELECT
        (SELECT COALESCE(SUM(page_count), 0)::int FROM documents WHERE bid_id = ${projectId}) as total_pages,
        (SELECT COUNT(*)::int FROM page_text pt
         JOIN documents d ON d.id = pt.document_id
         WHERE d.bid_id = ${projectId}) as indexed_pages,
        (SELECT COUNT(*)::int FROM page_text pt
         JOIN documents d ON d.id = pt.document_id
         WHERE d.bid_id = ${projectId} AND pt.needs_ocr = true) as pages_needing_ocr
    `);

    const statusRow = indexingStatus.rows[0] as {
      total_pages: number;
      indexed_pages: number;
      pages_needing_ocr: number;
    };

    // Check if query is a phrase (wrapped in quotes)
    const isPhrase = query.startsWith('"') && query.endsWith('"');
    const cleanQuery = isPhrase ? query.slice(1, -1) : query;

    // Build the search query using PostgreSQL full-text search
    // Use plainto_tsquery for regular queries, phraseto_tsquery for phrases
    const searchResults = await db.execute(sql`
      SELECT
        pt.document_id,
        d.filename as document_name,
        pt.page_number,
        ts_headline(
          'english',
          pt.raw_text,
          ${isPhrase
            ? sql`phraseto_tsquery('english', ${cleanQuery})`
            : sql`plainto_tsquery('english', ${cleanQuery})`
          },
          'StartSel=<mark>, StopSel=</mark>, MaxWords=25, MinWords=10, MaxFragments=1'
        ) as snippet,
        ts_rank(
          pt.text_search,
          ${isPhrase
            ? sql`phraseto_tsquery('english', ${cleanQuery})`
            : sql`plainto_tsquery('english', ${cleanQuery})`
          }
        ) as rank
      FROM page_text pt
      JOIN documents d ON d.id = pt.document_id
      WHERE d.bid_id = ${projectId}
        AND pt.text_search @@ ${isPhrase
          ? sql`phraseto_tsquery('english', ${cleanQuery})`
          : sql`plainto_tsquery('english', ${cleanQuery})`
        }
      ORDER BY rank DESC, d.filename, pt.page_number
      LIMIT 50
    `);

    const results: SearchResult[] = searchResults.rows.map((row: any) => ({
      documentId: row.document_id,
      documentName: row.document_name,
      pageNumber: row.page_number,
      snippet: row.snippet || '',
      rank: parseFloat(row.rank) || 0,
    }));

    const response: SearchResponse = {
      query,
      total: results.length,
      results,
      indexingStatus: {
        totalPages: statusRow.total_pages || 0,
        indexedPages: statusRow.indexed_pages || 0,
        pagesNeedingOcr: statusRow.pages_needing_ocr || 0,
      },
    };

    return NextResponse.json(response);
  } catch (error) {
    console.error('Search error:', error);
    return NextResponse.json(
      { error: 'Search failed' },
      { status: 500 }
    );
  }
}
