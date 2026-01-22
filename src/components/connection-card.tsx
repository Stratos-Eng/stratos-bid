'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useToast } from '@/components/ui/toast';

interface Platform {
  id: string;
  name: string;
  description: string;
  authType: 'oauth' | 'password';
}

interface Connection {
  id: string;
  platform: string;
  status: string;
  lastSynced: Date | null;
}

interface ConnectionCardProps {
  platform: Platform;
  connection?: Connection;
}

export function ConnectionCard({ platform, connection }: ConnectionCardProps) {
  const router = useRouter();
  const { addToast } = useToast();
  const [isConnecting, setIsConnecting] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');

  const isConnected = !!connection;

  const handleConnect = async () => {
    if (platform.authType === 'oauth') {
      // For Gmail, use NextAuth sign in
      window.location.href = '/api/auth/signin/google';
      return;
    }

    // Show credential form for password auth
    setShowForm(true);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsConnecting(true);
    setError('');

    try {
      const res = await fetch('/api/connections', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          platform: platform.id,
          email,
          password,
        }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to connect');
      }

      setShowForm(false);
      setEmail('');
      setPassword('');
      router.refresh();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setIsConnecting(false);
    }
  };

  const handleDisconnect = async () => {
    if (!confirm(`Disconnect from ${platform.name}?`)) return;

    try {
      const res = await fetch(`/api/connections?platform=${platform.id}`, {
        method: 'DELETE',
      });

      if (!res.ok) {
        throw new Error('Failed to disconnect');
      }

      addToast({
        type: 'success',
        message: `Disconnected from ${platform.name}`
      });
      router.refresh();
    } catch (err: any) {
      addToast({
        type: 'error',
        message: err.message || 'Failed to disconnect'
      });
    }
  };

  const handleSync = async () => {
    try {
      const res = await fetch('/api/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ connectionId: connection?.id }),
      });

      if (!res.ok) {
        throw new Error('Failed to trigger sync');
      }

      addToast({
        type: 'success',
        message: 'Sync started! Refresh in a few minutes to see new bids.'
      });
    } catch (err: any) {
      addToast({
        type: 'error',
        message: err.message || 'Failed to trigger sync'
      });
    }
  };

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-6">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="font-medium text-gray-900">{platform.name}</h3>
          <p className="text-sm text-gray-500 mt-1">{platform.description}</p>
          {connection?.lastSynced && (
            <p className="text-xs text-gray-400 mt-2">
              Last synced:{' '}
              {new Date(connection.lastSynced).toLocaleString()}
            </p>
          )}
        </div>

        <div className="flex items-center gap-3">
          {isConnected && (
            <>
              <span
                className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${
                  connection.status === 'active'
                    ? 'bg-green-100 text-green-800'
                    : connection.status === 'error'
                    ? 'bg-red-100 text-red-800'
                    : 'bg-yellow-100 text-yellow-800'
                }`}
              >
                {connection.status === 'active'
                  ? 'Connected'
                  : connection.status === 'error'
                  ? 'Error'
                  : 'Needs Reauth'}
              </span>
              <button
                onClick={handleSync}
                className="px-3 py-2 text-sm font-medium text-blue-600 hover:text-blue-800"
              >
                Sync Now
              </button>
              <button
                onClick={handleDisconnect}
                className="px-3 py-2 text-sm font-medium text-red-600 hover:text-red-800"
              >
                Disconnect
              </button>
            </>
          )}
          {!isConnected && !showForm && (
            <button
              onClick={handleConnect}
              className="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 text-sm font-medium"
            >
              Connect
            </button>
          )}
        </div>
      </div>

      {/* Credential Form */}
      {showForm && (
        <form onSubmit={handleSubmit} className="mt-4 border-t pt-4">
          <div className="grid gap-4 max-w-md">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Email
              </label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-blue-500 focus:border-blue-500"
                placeholder={`Your ${platform.name} email`}
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Password
              </label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-blue-500 focus:border-blue-500"
                placeholder={`Your ${platform.name} password`}
              />
            </div>
            {error && (
              <p className="text-sm text-red-600">{error}</p>
            )}
            <div className="flex gap-3">
              <button
                type="submit"
                disabled={isConnecting}
                className="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 text-sm font-medium disabled:opacity-50"
              >
                {isConnecting ? 'Connecting...' : 'Save Connection'}
              </button>
              <button
                type="button"
                onClick={() => setShowForm(false)}
                className="px-4 py-2 text-gray-600 hover:text-gray-800 text-sm font-medium"
              >
                Cancel
              </button>
            </div>
          </div>
        </form>
      )}
    </div>
  );
}
