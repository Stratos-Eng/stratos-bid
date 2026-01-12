'use client';

import { useState } from 'react';

export function SyncButton({ connectionId }: { connectionId: string }) {
  const [syncing, setSyncing] = useState(false);
  const [message, setMessage] = useState('');

  async function handleSync() {
    setSyncing(true);
    setMessage('');

    try {
      const res = await fetch('/api/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ connectionId }),
      });

      const data = await res.json();

      if (res.ok) {
        setMessage('Sync started!');
      } else {
        setMessage(data.error || 'Sync failed');
      }
    } catch (error) {
      setMessage('Network error');
    } finally {
      setSyncing(false);
    }
  }

  return (
    <div className="flex items-center gap-2">
      <button
        onClick={handleSync}
        disabled={syncing}
        className="text-sm text-blue-600 hover:text-blue-800 disabled:text-gray-400"
      >
        {syncing ? 'Syncing...' : 'Sync Now'}
      </button>
      {message && (
        <span className="text-xs text-gray-500">{message}</span>
      )}
    </div>
  );
}
