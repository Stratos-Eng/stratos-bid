import { auth } from '@/lib/auth';
import { redirect } from 'next/navigation';
import { db } from '@/db';
import { connections } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { encryptCredentials } from '@/lib/crypto';
import { SyncButton } from '@/components/SyncButton';

const statusColors: Record<string, string> = {
  active: 'bg-green-100 text-green-800',
  error: 'bg-red-100 text-red-800',
  needs_reauth: 'bg-yellow-100 text-yellow-800',
};

const platformInfo: Record<string, { name: string; authType: 'oauth' | 'password' }> = {
  gmail: { name: 'Gmail', authType: 'oauth' },
  planhub: { name: 'PlanHub', authType: 'password' },
  buildingconnected: { name: 'BuildingConnected', authType: 'password' },
  planetbids: { name: 'PlanetBids', authType: 'password' },
};

function formatDate(date: Date | null): string {
  if (!date) return 'Never';
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

export default async function ConnectionsPage() {
  const session = await auth();
  if (!session?.user?.id) {
    redirect('/login');
  }

  const userConnections = await db
    .select()
    .from(connections)
    .where(eq(connections.userId, session.user.id));

  // Server action to add password connection
  async function addPasswordConnection(formData: FormData) {
    'use server';
    const session = await auth();
    if (!session?.user?.id) return;

    const platform = formData.get('platform') as string;
    const email = formData.get('email') as string;
    const password = formData.get('password') as string;

    if (!platform || !email || !password) return;

    const encryptedCreds = encryptCredentials({ email, password });

    await db.insert(connections).values({
      userId: session.user.id,
      platform,
      authType: 'password',
      credentials: encryptedCreds,
      status: 'active',
    });

    revalidatePath('/connections');
  }

  // Server action to delete connection
  async function deleteConnection(formData: FormData) {
    'use server';
    const session = await auth();
    if (!session?.user?.id) return;

    const connectionId = formData.get('connectionId') as string;
    if (!connectionId) return;

    await db.delete(connections).where(eq(connections.id, connectionId));
    revalidatePath('/connections');
  }

  // Check which platforms are already connected
  const connectedPlatforms = new Set(userConnections.map((c) => c.platform));

  return (
    <div>
      <h1 className="text-2xl font-bold text-gray-900 mb-6">Connections</h1>

      {/* Existing Connections */}
      <div className="mb-8">
        <h2 className="text-lg font-semibold text-gray-800 mb-4">
          Your Connections
        </h2>
        {userConnections.length === 0 ? (
          <div className="bg-white rounded-lg border p-6 text-center">
            <p className="text-gray-500">No connections yet</p>
            <p className="text-sm text-gray-400 mt-1">
              Add connections below to start syncing bids
            </p>
          </div>
        ) : (
          <div className="bg-white rounded-lg border divide-y">
            {userConnections.map((conn) => (
              <div
                key={conn.id}
                className="p-4 flex items-center justify-between"
              >
                <div>
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-gray-900">
                      {platformInfo[conn.platform]?.name || conn.platform}
                    </span>
                    <span
                      className={`px-2 py-0.5 rounded text-xs font-medium ${statusColors[conn.status] || 'bg-gray-100'}`}
                    >
                      {conn.status}
                    </span>
                  </div>
                  <p className="text-sm text-gray-500 mt-1">
                    Last synced: {formatDate(conn.lastSynced)}
                  </p>
                </div>
                <div className="flex items-center gap-4">
                  <SyncButton connectionId={conn.id} />
                  <form action={deleteConnection}>
                    <input type="hidden" name="connectionId" value={conn.id} />
                    <button
                      type="submit"
                      className="text-sm text-red-600 hover:text-red-800"
                    >
                      Disconnect
                    </button>
                  </form>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Add New Connection */}
      <div className="bg-white rounded-lg border p-6">
        <h2 className="text-lg font-semibold text-gray-800 mb-4">
          Add New Connection
        </h2>

        {/* Gmail - auto-connected on login */}
        {!connectedPlatforms.has('gmail') && (
          <div className="mb-4 p-4 bg-yellow-50 border border-yellow-200 rounded-lg">
            <p className="text-sm text-yellow-800">
              Gmail is automatically connected when you sign in with Google.
              Try signing out and back in to connect Gmail.
            </p>
          </div>
        )}

        {/* PlanHub */}
        {!connectedPlatforms.has('planhub') && (
          <form action={addPasswordConnection} className="mb-4 p-4 bg-gray-50 rounded-lg">
            <h3 className="font-medium text-gray-900 mb-3">PlanHub</h3>
            <input type="hidden" name="platform" value="planhub" />
            <div className="grid grid-cols-2 gap-4">
              <input
                type="email"
                name="email"
                placeholder="Email"
                required
                className="px-3 py-2 border rounded-lg"
              />
              <input
                type="password"
                name="password"
                placeholder="Password"
                required
                className="px-3 py-2 border rounded-lg"
              />
            </div>
            <button
              type="submit"
              className="mt-3 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700"
            >
              Connect PlanHub
            </button>
          </form>
        )}

        {/* BuildingConnected */}
        {!connectedPlatforms.has('buildingconnected') && (
          <form action={addPasswordConnection} className="p-4 bg-gray-50 rounded-lg">
            <h3 className="font-medium text-gray-900 mb-3">BuildingConnected</h3>
            <input type="hidden" name="platform" value="buildingconnected" />
            <div className="grid grid-cols-2 gap-4">
              <input
                type="email"
                name="email"
                placeholder="Email"
                required
                className="px-3 py-2 border rounded-lg"
              />
              <input
                type="password"
                name="password"
                placeholder="Password"
                required
                className="px-3 py-2 border rounded-lg"
              />
            </div>
            <button
              type="submit"
              className="mt-3 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700"
            >
              Connect BuildingConnected
            </button>
          </form>
        )}

        {connectedPlatforms.size >= 3 && (
          <p className="text-center text-gray-500">
            All available platforms connected!
          </p>
        )}
      </div>
    </div>
  );
}
