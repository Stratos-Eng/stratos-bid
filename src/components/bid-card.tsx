import Link from 'next/link';

interface BidCardProps {
  bid: {
    id: string;
    title: string;
    sourcePlatform: string;
    city: string | null;
    state: string | null;
    bidDueDate: Date | null;
    relevanceScore: number | null;
    status: string;
    sourceUrl: string | null;
    createdAt: Date;
  };
}

function formatDate(date: Date | null) {
  if (!date) return 'No due date';
  return new Date(date).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

function getRelevanceColor(score: number | null) {
  if (!score) return 'bg-gray-200 text-gray-700';
  if (score >= 0.7) return 'bg-green-100 text-green-800';
  if (score >= 0.4) return 'bg-yellow-100 text-yellow-800';
  return 'bg-gray-100 text-gray-700';
}

function getStatusColor(status: string) {
  switch (status) {
    case 'new':
      return 'bg-blue-100 text-blue-800';
    case 'reviewing':
      return 'bg-yellow-100 text-yellow-800';
    case 'bidding':
      return 'bg-green-100 text-green-800';
    case 'passed':
      return 'bg-gray-100 text-gray-600';
    case 'won':
      return 'bg-emerald-100 text-emerald-800';
    case 'lost':
      return 'bg-red-100 text-red-800';
    default:
      return 'bg-gray-100 text-gray-700';
  }
}

function getPlatformName(platform: string) {
  switch (platform) {
    case 'planhub':
      return 'PlanHub';
    case 'buildingconnected':
      return 'BuildingConnected';
    case 'gmail':
      return 'Gmail';
    case 'planetbids':
      return 'PlanetBids';
    default:
      return platform;
  }
}

export function BidCard({ bid }: BidCardProps) {
  const relevancePercent = bid.relevanceScore ? Math.round(bid.relevanceScore * 100) : 0;

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4 hover:shadow-md transition-shadow">
      <div className="flex items-start justify-between">
        <div className="flex items-start gap-4">
          {/* Relevance Score Circle */}
          <div
            className={`w-12 h-12 rounded-full flex items-center justify-center text-sm font-semibold ${getRelevanceColor(bid.relevanceScore)}`}
          >
            {relevancePercent}%
          </div>

          {/* Bid Info */}
          <div className="flex-1">
            <h3 className="font-medium text-gray-900 mb-1">
              {bid.sourceUrl ? (
                <a
                  href={bid.sourceUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="hover:text-blue-600 hover:underline"
                >
                  {bid.title}
                </a>
              ) : (
                bid.title
              )}
            </h3>
            <div className="flex items-center gap-3 text-sm text-gray-500">
              <span>{getPlatformName(bid.sourcePlatform)}</span>
              <span>•</span>
              <span>Due {formatDate(bid.bidDueDate)}</span>
              {bid.city && bid.state && (
                <>
                  <span>•</span>
                  <span>
                    {bid.city}, {bid.state}
                  </span>
                </>
              )}
            </div>
          </div>
        </div>

        {/* Status Badge */}
        <span
          className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${getStatusColor(bid.status)}`}
        >
          {bid.status.charAt(0).toUpperCase() + bid.status.slice(1)}
        </span>
      </div>
    </div>
  );
}
