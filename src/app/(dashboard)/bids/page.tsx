import { auth } from '@/lib/auth';
import { redirect } from 'next/navigation';
import { db } from '@/db';
import { bids } from '@/db/schema';
import { eq, desc, and } from 'drizzle-orm';
import Link from 'next/link';

// Status badge colors
const statusColors: Record<string, string> = {
  new: 'bg-blue-100 text-blue-800',
  reviewing: 'bg-yellow-100 text-yellow-800',
  bidding: 'bg-purple-100 text-purple-800',
  passed: 'bg-gray-100 text-gray-800',
  won: 'bg-green-100 text-green-800',
  lost: 'bg-red-100 text-red-800',
};

// Platform badge colors
const platformColors: Record<string, string> = {
  planhub: 'bg-orange-100 text-orange-800',
  buildingconnected: 'bg-blue-100 text-blue-800',
  gmail: 'bg-red-100 text-red-800',
  planetbids: 'bg-green-100 text-green-800',
};

function formatDate(date: Date | null): string {
  if (!date) return '-';
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(date);
}

function getRelevanceColor(score: number | null): string {
  if (!score) return 'text-gray-400';
  if (score >= 0.8) return 'text-green-600';
  if (score >= 0.5) return 'text-yellow-600';
  return 'text-red-600';
}

export default async function BidsPage({
  searchParams,
}: {
  searchParams: { status?: string; platform?: string };
}) {
  const session = await auth();
  if (!session?.user?.id) {
    redirect('/login');
  }

  // Build query conditions
  const conditions = [eq(bids.userId, session.user.id)];

  if (searchParams.status) {
    conditions.push(eq(bids.status, searchParams.status));
  }
  if (searchParams.platform) {
    conditions.push(eq(bids.sourcePlatform, searchParams.platform));
  }

  // Fetch bids
  const userBids = await db
    .select()
    .from(bids)
    .where(and(...conditions))
    .orderBy(desc(bids.bidDueDate), desc(bids.createdAt))
    .limit(100);

  return (
    <div>
      {/* Header */}
      <div className="flex justify-between items-center mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Bid Inbox</h1>
        <div className="flex gap-2">
          {/* Filters */}
          <select
            className="px-3 py-2 border rounded-lg text-sm"
            defaultValue={searchParams.status || ''}
          >
            <option value="">All Statuses</option>
            <option value="new">New</option>
            <option value="reviewing">Reviewing</option>
            <option value="bidding">Bidding</option>
            <option value="passed">Passed</option>
            <option value="won">Won</option>
            <option value="lost">Lost</option>
          </select>
          <select
            className="px-3 py-2 border rounded-lg text-sm"
            defaultValue={searchParams.platform || ''}
          >
            <option value="">All Platforms</option>
            <option value="planhub">PlanHub</option>
            <option value="buildingconnected">BuildingConnected</option>
            <option value="gmail">Gmail</option>
            <option value="planetbids">PlanetBids</option>
          </select>
        </div>
      </div>

      {/* Bid list */}
      {userBids.length === 0 ? (
        <div className="text-center py-12 bg-white rounded-lg border">
          <p className="text-gray-500">No bids found</p>
          <p className="text-sm text-gray-400 mt-1">
            Connect your accounts to start receiving bids
          </p>
          <Link
            href="/connections"
            className="inline-block mt-4 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700"
          >
            Connect Accounts
          </Link>
        </div>
      ) : (
        <div className="bg-white rounded-lg border divide-y">
          {userBids.map((bid) => (
            <div
              key={bid.id}
              className="p-4 hover:bg-gray-50 transition-colors"
            >
              <div className="flex items-start justify-between gap-4">
                <div className="flex-1 min-w-0">
                  {/* Title and badges */}
                  <div className="flex items-center gap-2 mb-1">
                    <span
                      className={`text-sm font-medium ${getRelevanceColor(bid.relevanceScore)}`}
                    >
                      {bid.relevanceScore
                        ? `${Math.round(bid.relevanceScore * 100)}%`
                        : '-'}
                    </span>
                    <h3 className="font-medium text-gray-900 truncate">
                      {bid.title}
                    </h3>
                  </div>

                  {/* Meta info */}
                  <div className="flex items-center gap-3 text-sm text-gray-500">
                    <span
                      className={`px-2 py-0.5 rounded text-xs font-medium ${platformColors[bid.sourcePlatform] || 'bg-gray-100'}`}
                    >
                      {bid.sourcePlatform}
                    </span>
                    {bid.city && bid.state && (
                      <span>
                        {bid.city}, {bid.state}
                      </span>
                    )}
                    {bid.bidDueDate && (
                      <span>Due: {formatDate(bid.bidDueDate)}</span>
                    )}
                  </div>

                  {/* Description preview */}
                  {bid.description && (
                    <p className="mt-2 text-sm text-gray-600 line-clamp-2">
                      {bid.description}
                    </p>
                  )}
                </div>

                <div className="flex flex-col items-end gap-2">
                  <span
                    className={`px-2 py-1 rounded text-xs font-medium ${statusColors[bid.status] || 'bg-gray-100'}`}
                  >
                    {bid.status}
                  </span>
                  {bid.sourceUrl && (
                    <a
                      href={bid.sourceUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-sm text-blue-600 hover:underline"
                    >
                      View →
                    </a>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
