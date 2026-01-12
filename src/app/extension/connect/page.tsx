'use client';

import { useEffect, useState } from 'react';
import { useSession } from 'next-auth/react';
import { redirect } from 'next/navigation';

interface TokenResponse {
  token: string;
  userId: string;
  expiresAt: string;
}

export default function ExtensionConnectPage() {
  const { data: session, status } = useSession();
  const [tokenData, setTokenData] = useState<TokenResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  // Redirect to login if not authenticated
  useEffect(() => {
    if (status === 'unauthenticated') {
      redirect('/login?callbackUrl=/extension/connect');
    }
  }, [status]);

  // Fetch extension token when authenticated
  useEffect(() => {
    if (status === 'authenticated' && !tokenData && !error) {
      fetchExtensionToken();
    }
  }, [status, tokenData, error]);

  async function fetchExtensionToken() {
    try {
      const response = await fetch('/api/extension/token', {
        method: 'POST',
        credentials: 'include',
      });

      if (!response.ok) {
        throw new Error('Failed to generate token');
      }

      const data: TokenResponse = await response.json();
      setTokenData(data);

      // Try to send token to extension
      sendTokenToExtension(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    }
  }

  function sendTokenToExtension(data: TokenResponse) {
    // Method 1: Post message for content script
    window.postMessage(
      {
        type: 'STRATOS_EXTENSION_TOKEN',
        token: data.token,
        userId: data.userId,
        expiresAt: data.expiresAt,
      },
      window.location.origin
    );

    // Method 2: Try Chrome runtime (if extension ID is known)
    // This requires the extension to declare externally_connectable in manifest
    // For now, we rely on the content script picking up the postMessage

    setSent(true);
  }

  function handleCopyToken() {
    if (tokenData?.token) {
      navigator.clipboard.writeText(tokenData.token);
    }
  }

  if (status === 'loading') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <div className="text-center">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600 mx-auto"></div>
          <p className="mt-4 text-gray-600">Loading...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50">
      <div className="max-w-md w-full bg-white rounded-xl shadow-lg p-8">
        <div className="text-center mb-6">
          <div className="w-16 h-16 bg-blue-100 rounded-full flex items-center justify-center mx-auto mb-4">
            <svg
              className="w-8 h-8 text-blue-600"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"
              />
            </svg>
          </div>
          <h1 className="text-2xl font-bold text-gray-900">Connect Extension</h1>
          <p className="text-gray-500 mt-2">
            Link your Stratos browser extension
          </p>
        </div>

        {error ? (
          <div className="bg-red-50 border border-red-200 rounded-lg p-4 mb-6">
            <p className="text-red-700">{error}</p>
            <button
              onClick={() => {
                setError(null);
                fetchExtensionToken();
              }}
              className="mt-2 text-red-600 underline text-sm"
            >
              Try again
            </button>
          </div>
        ) : tokenData ? (
          <div className="space-y-4">
            {sent ? (
              <div className="bg-green-50 border border-green-200 rounded-lg p-4">
                <div className="flex items-center">
                  <svg
                    className="w-5 h-5 text-green-500 mr-2"
                    fill="currentColor"
                    viewBox="0 0 20 20"
                  >
                    <path
                      fillRule="evenodd"
                      d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z"
                      clipRule="evenodd"
                    />
                  </svg>
                  <span className="text-green-700 font-medium">
                    Token sent to extension!
                  </span>
                </div>
                <p className="text-green-600 text-sm mt-2">
                  Check your extension popup. If the connection didn&apos;t work
                  automatically, copy the token below.
                </p>
              </div>
            ) : (
              <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
                <p className="text-blue-700">Sending token to extension...</p>
              </div>
            )}

            <div className="border rounded-lg p-4">
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Extension Token (expires {new Date(tokenData.expiresAt).toLocaleDateString()})
              </label>
              <div className="flex gap-2">
                <input
                  type="text"
                  readOnly
                  value={tokenData.token.slice(0, 20) + '...'}
                  className="flex-1 px-3 py-2 border rounded-lg bg-gray-50 text-sm font-mono"
                />
                <button
                  onClick={handleCopyToken}
                  className="px-4 py-2 bg-gray-100 hover:bg-gray-200 rounded-lg text-sm font-medium transition-colors"
                >
                  Copy
                </button>
              </div>
            </div>

            <div className="text-center text-sm text-gray-500">
              <p>Logged in as {session?.user?.email}</p>
            </div>
          </div>
        ) : (
          <div className="text-center">
            <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-blue-600 mx-auto"></div>
            <p className="mt-2 text-gray-500">Generating token...</p>
          </div>
        )}

        <div className="mt-6 pt-6 border-t">
          <a
            href="/dashboard"
            className="block text-center text-blue-600 hover:text-blue-700 text-sm"
          >
            Go to Dashboard
          </a>
        </div>
      </div>
    </div>
  );
}
