import { auth } from '@/lib/auth';
import { db } from '@/db';
import { bids } from '@/db/schema';
import { eq, desc } from 'drizzle-orm';
import { redirect } from 'next/navigation';
import { BidCard } from '@/components/bid-card';

export default async function BidsPage() {
  const session = await auth();

  if (!session?.user?.id) {
    redirect('/login');
  }

  const userBids = await db
    .select()
    .from(bids)
    .where(eq(bids.userId, session.user.id))
    .orderBy(desc(bids.relevanceScore), desc(bids.createdAt));

  return (
    <div>
      <div className="flex justify-between items-center mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Bid Inbox</h1>
        <div className="flex gap-2">
          <select className="rounded-md border-gray-300 text-sm px-3 py-2 border">
            <option value="">All Platforms</option>
            <option value="planhub">PlanHub</option>
            <option value="buildingconnected">BuildingConnected</option>
            <option value="gmail">Gmail</option>
          </select>
          <select className="rounded-md border-gray-300 text-sm px-3 py-2 border">
            <option value="">All Status</option>
            <option value="new">New</option>
            <option value="reviewing">Reviewing</option>
            <option value="bidding">Bidding</option>
            <option value="passed">Passed</option>
          </select>
        </div>
      </div>

      {userBids.length === 0 ? (
        <div className="text-center py-12 bg-white rounded-lg border border-gray-200">
          <h3 className="text-lg font-medium text-gray-900 mb-2">No bids yet</h3>
          <p className="text-gray-500 mb-4">
            Connect your accounts to start syncing bid opportunities.
          </p>
          <a
            href="/connections"
            className="inline-flex items-center px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700"
          >
            Connect Accounts
          </a>
        </div>
      ) : (
        <div className="space-y-4">
          {userBids.map((bid) => (
            <BidCard key={bid.id} bid={bid} />
          ))}
        </div>
      )}
    </div>
  );
}
