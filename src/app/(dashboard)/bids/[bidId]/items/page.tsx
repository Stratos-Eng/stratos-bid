import { auth } from '@/lib/auth';
import { redirect, notFound } from 'next/navigation';
import { db } from '@/db';
import { bids, lineItems, documents } from '@/db/schema';
import { eq, and, desc } from 'drizzle-orm';
import Link from 'next/link';
import { TRADE_DEFINITIONS, type TradeCode } from '@/lib/trade-definitions';
import { LineItemsTable } from '@/components/line-items-table';

export default async function LineItemsPage({
  params,
  searchParams,
}: {
  params: Promise<{ bidId: string }>;
  searchParams: Promise<{ trade?: string; status?: string }>;
}) {
  const session = await auth();
  if (!session?.user?.id) {
    redirect('/login');
  }

  const { bidId } = await params;
  const { trade, status } = await searchParams;

  // Fetch bid
  const [bid] = await db
    .select()
    .from(bids)
    .where(and(eq(bids.id, bidId), eq(bids.userId, session.user.id)))
    .limit(1);

  if (!bid) {
    notFound();
  }

  // Build conditions
  const conditions = [eq(lineItems.bidId, bidId)];

  if (trade) {
    conditions.push(eq(lineItems.tradeCode, trade));
  }
  if (status) {
    conditions.push(eq(lineItems.reviewStatus, status));
  }

  // Fetch line items
  const items = await db
    .select({
      id: lineItems.id,
      tradeCode: lineItems.tradeCode,
      category: lineItems.category,
      description: lineItems.description,
      estimatedQty: lineItems.estimatedQty,
      unit: lineItems.unit,
      notes: lineItems.notes,
      pageNumber: lineItems.pageNumber,
      pageReference: lineItems.pageReference,
      extractionConfidence: lineItems.extractionConfidence,
      reviewStatus: lineItems.reviewStatus,
      pdfFilePath: lineItems.pdfFilePath,
      documentId: lineItems.documentId,
    })
    .from(lineItems)
    .where(and(...conditions))
    .orderBy(lineItems.tradeCode, lineItems.category, lineItems.pageNumber);

  // Fetch documents for PDF viewer links
  const bidDocuments = await db
    .select({
      id: documents.id,
      filename: documents.filename,
      storagePath: documents.storagePath,
    })
    .from(documents)
    .where(eq(documents.bidId, bidId));

  const docMap = new Map(bidDocuments.map((d) => [d.id, d]));

  // Get counts by trade
  const tradeCounts: Record<string, number> = {};
  items.forEach((item) => {
    tradeCounts[item.tradeCode] = (tradeCounts[item.tradeCode] || 0) + 1;
  });

  return (
    <div className="max-w-7xl mx-auto">
      {/* Breadcrumb */}
      <div className="mb-4">
        <Link
          href={`/bids/${bidId}`}
          className="text-blue-600 hover:underline text-sm"
        >
          &larr; Back to Bid
        </Link>
      </div>

      {/* Header */}
      <div className="flex justify-between items-center mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Line Items</h1>
          <p className="text-gray-500">{bid.title}</p>
        </div>

        <div className="flex gap-2">
          <Link
            href={`/api/export?bidId=${bidId}${trade ? `&trade=${trade}` : ''}`}
            className="px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 text-sm"
          >
            Export Excel
          </Link>
        </div>
      </div>

      {/* Trade Filter Tabs */}
      <div className="flex gap-2 mb-6 border-b">
        <Link
          href={`/bids/${bidId}/items`}
          className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px ${
            !trade
              ? 'border-blue-600 text-blue-600'
              : 'border-transparent text-gray-500 hover:text-gray-700'
          }`}
        >
          All ({items.length})
        </Link>
        {Object.entries(TRADE_DEFINITIONS).map(([code, tradeDef]) => {
          const count = tradeCounts[code] || 0;
          if (count === 0 && trade !== code) return null;
          return (
            <Link
              key={code}
              href={`/bids/${bidId}/items?trade=${code}`}
              className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px ${
                trade === code
                  ? 'border-blue-600 text-blue-600'
                  : 'border-transparent text-gray-500 hover:text-gray-700'
              }`}
            >
              {tradeDef.name} ({count})
            </Link>
          );
        })}
      </div>

      {/* Status Filter */}
      <div className="flex gap-2 mb-4">
        <Link
          href={`/bids/${bidId}/items${trade ? `?trade=${trade}` : ''}`}
          className={`px-3 py-1 text-sm rounded-full ${
            !status
              ? 'bg-gray-900 text-white'
              : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
          }`}
        >
          All
        </Link>
        {['pending', 'approved', 'rejected'].map((statusOption) => (
          <Link
            key={statusOption}
            href={`/bids/${bidId}/items?${trade ? `trade=${trade}&` : ''}status=${statusOption}`}
            className={`px-3 py-1 text-sm rounded-full capitalize ${
              status === statusOption
                ? 'bg-gray-900 text-white'
                : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
            }`}
          >
            {statusOption}
          </Link>
        ))}
      </div>

      {/* Line Items Table */}
      {items.length === 0 ? (
        <div className="text-center py-12 bg-white rounded-lg border">
          <p className="text-gray-500">No line items found</p>
          <p className="text-sm text-gray-400 mt-1">
            Extract documents to populate line items
          </p>
        </div>
      ) : (
        <LineItemsTable
          items={items.map((item) => ({
            ...item,
            documentFilename: docMap.get(item.documentId)?.filename || null,
          }))}
          bidId={bidId}
        />
      )}
    </div>
  );
}
