import { auth } from '@/lib/auth';
import { redirect, notFound } from 'next/navigation';
import { db } from '@/db';
import { bids, documents, lineItems } from '@/db/schema';
import { eq, and, sql } from 'drizzle-orm';
import Link from 'next/link';
import { TRADE_DEFINITIONS, type TradeCode } from '@/lib/trade-definitions';
import { DocumentActions } from '@/components/document-actions';

// Status badge colors
const statusColors: Record<string, string> = {
  new: 'bg-blue-100 text-blue-800',
  reviewing: 'bg-yellow-100 text-yellow-800',
  bidding: 'bg-purple-100 text-purple-800',
  passed: 'bg-gray-100 text-gray-800',
  won: 'bg-green-100 text-green-800',
  lost: 'bg-red-100 text-red-800',
};

const extractionStatusColors: Record<string, string> = {
  not_started: 'bg-gray-100 text-gray-600',
  queued: 'bg-yellow-100 text-yellow-700',
  extracting: 'bg-blue-100 text-blue-700',
  completed: 'bg-green-100 text-green-700',
  failed: 'bg-red-100 text-red-700',
};

function formatDate(date: Date | null): string {
  if (!date) return '-';
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(date);
}

export default async function BidDetailPage({
  params,
}: {
  params: Promise<{ bidId: string }>;
}) {
  const session = await auth();
  if (!session?.user?.id) {
    redirect('/login');
  }

  const { bidId } = await params;

  // Fetch bid details
  const [bid] = await db
    .select()
    .from(bids)
    .where(and(eq(bids.id, bidId), eq(bids.userId, session.user.id)))
    .limit(1);

  if (!bid) {
    notFound();
  }

  // Fetch documents with extraction status
  const bidDocuments = await db
    .select()
    .from(documents)
    .where(eq(documents.bidId, bidId))
    .orderBy(documents.filename);

  // Fetch line item counts by trade
  const lineItemStats = await db
    .select({
      tradeCode: lineItems.tradeCode,
      count: sql<number>`count(*)::int`,
      pendingCount: sql<number>`count(*) filter (where ${lineItems.reviewStatus} = 'pending')::int`,
      approvedCount: sql<number>`count(*) filter (where ${lineItems.reviewStatus} = 'approved')::int`,
    })
    .from(lineItems)
    .where(eq(lineItems.bidId, bidId))
    .groupBy(lineItems.tradeCode);

  const totalLineItems = lineItemStats.reduce((sum, s) => sum + s.count, 0);

  return (
    <div className="max-w-6xl mx-auto">
      {/* Breadcrumb */}
      <div className="mb-4">
        <Link href="/bids" className="text-blue-600 hover:underline text-sm">
          ← Back to Bids
        </Link>
      </div>

      {/* Bid Header */}
      <div className="bg-white rounded-lg border p-6 mb-6">
        <div className="flex justify-between items-start">
          <div>
            <h1 className="text-2xl font-bold text-gray-900 mb-2">{bid.title}</h1>
            <div className="flex items-center gap-3 text-sm text-gray-500">
              <span
                className={`px-2 py-0.5 rounded text-xs font-medium ${statusColors[bid.status]}`}
              >
                {bid.status}
              </span>
              {bid.city && bid.state && (
                <span>
                  {bid.city}, {bid.state}
                </span>
              )}
              {bid.bidDueDate && <span>Due: {formatDate(bid.bidDueDate)}</span>}
            </div>
          </div>
          {bid.sourceUrl && (
            <a
              href={bid.sourceUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 text-sm"
            >
              View Original
            </a>
          )}
        </div>

        {bid.description && (
          <p className="mt-4 text-gray-600">{bid.description}</p>
        )}
      </div>

      {/* Line Items Summary */}
      {totalLineItems > 0 && (
        <div className="bg-white rounded-lg border p-6 mb-6">
          <div className="flex justify-between items-center mb-4">
            <h2 className="text-lg font-semibold">Extracted Line Items</h2>
            <Link
              href={`/bids/${bidId}/items`}
              className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 text-sm"
            >
              Review All Items ({totalLineItems})
            </Link>
          </div>

          <div className="grid grid-cols-2 gap-4">
            {lineItemStats.map((stat) => {
              const trade = TRADE_DEFINITIONS[stat.tradeCode as TradeCode];
              const isSignage = stat.tradeCode === 'division_10';
              return (
                <div
                  key={stat.tradeCode}
                  className="p-4 border rounded-lg hover:border-blue-300 transition-colors"
                >
                  <Link href={`/bids/${bidId}/items?trade=${stat.tradeCode}`}>
                    <div className="flex justify-between items-start">
                      <div>
                        <h3 className="font-medium">{trade?.name || stat.tradeCode}</h3>
                        <p className="text-sm text-gray-500">{trade?.displayName}</p>
                      </div>
                      <span className="text-2xl font-bold text-gray-900">{stat.count}</span>
                    </div>
                    <div className="mt-2 flex gap-2 text-xs">
                      <span className="text-yellow-600">{stat.pendingCount} pending</span>
                      <span className="text-green-600">{stat.approvedCount} approved</span>
                    </div>
                  </Link>
                  {isSignage && stat.pendingCount > 0 && (
                    <Link
                      href={`/signage/${bidId}`}
                      className="mt-3 block w-full text-center px-3 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 text-sm font-medium"
                    >
                      Review Signage →
                    </Link>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Documents */}
      <div className="bg-white rounded-lg border p-6">
        <h2 className="text-lg font-semibold mb-4">
          Documents ({bidDocuments.length})
        </h2>

        {bidDocuments.length === 0 ? (
          <p className="text-gray-500">No documents attached to this bid</p>
        ) : (
          <div className="divide-y">
            {bidDocuments.map((doc) => (
              <div
                key={doc.id}
                className="py-3 flex items-center justify-between"
              >
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-gray-900">
                      {doc.filename}
                    </span>
                    {doc.pageCount && (
                      <span className="text-xs text-gray-500">
                        ({doc.pageCount} pages)
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-3 mt-1">
                    <span
                      className={`text-xs px-2 py-0.5 rounded ${extractionStatusColors[doc.extractionStatus || 'not_started']}`}
                    >
                      {doc.extractionStatus === 'completed' ? 'Ready' :
                        doc.extractionStatus === 'extracting' ? 'Working…' :
                        doc.extractionStatus === 'queued' ? 'Starting…' :
                        doc.extractionStatus === 'failed' ? 'Needs attention' :
                        'Waiting'}
                    </span>
                    {doc.lineItemCount !== null && doc.lineItemCount > 0 && (
                      <span className="text-xs text-green-600">
                        {doc.lineItemCount} items extracted
                      </span>
                    )}
                  </div>
                </div>

                <DocumentActions
                  bidId={bidId}
                  documentId={doc.id}
                  extractionStatus={doc.extractionStatus}
                  hasStoragePath={!!doc.storagePath}
                />
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
