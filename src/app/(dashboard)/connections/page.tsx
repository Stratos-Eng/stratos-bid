import { auth } from '@/lib/auth';
import { db } from '@/db';
import { connections } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { redirect } from 'next/navigation';
import { ConnectionCard } from '@/components/connection-card';

const platforms = [
  {
    id: 'gmail',
    name: 'Gmail',
    description: 'Scan your inbox for bid invitation emails',
    authType: 'oauth' as const,
  },
  {
    id: 'planhub',
    name: 'PlanHub',
    description: 'Sync projects and bid invitations from PlanHub',
    authType: 'password' as const,
  },
  {
    id: 'buildingconnected',
    name: 'BuildingConnected',
    description: 'Sync bid opportunities from BuildingConnected',
    authType: 'password' as const,
  },
];

export default async function ConnectionsPage() {
  const session = await auth();

  if (!session?.user?.id) {
    redirect('/login');
  }

  const userConnections = await db
    .select()
    .from(connections)
    .where(eq(connections.userId, session.user.id));

  const connectionMap = new Map(userConnections.map((c) => [c.platform, c]));

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Connections</h1>
        <p className="text-gray-500 mt-1">
          Connect your accounts to start syncing bid opportunities.
        </p>
      </div>

      <div className="space-y-4">
        {platforms.map((platform) => (
          <ConnectionCard
            key={platform.id}
            platform={platform}
            connection={connectionMap.get(platform.id)}
          />
        ))}
      </div>
    </div>
  );
}
