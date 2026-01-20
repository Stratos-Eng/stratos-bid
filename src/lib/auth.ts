import { auth, currentUser } from '@clerk/nextjs/server';
import { createClerkClient } from '@clerk/nextjs/server';

const clerkClient = createClerkClient({
  secretKey: process.env.CLERK_SECRET_KEY,
});

export interface Session {
  user: {
    id: string;
    email: string | null | undefined;
    name: string | null;
  };
}

export async function getSession(): Promise<Session | null> {
  const { userId } = await auth();
  if (!userId) return null;

  const user = await currentUser();
  return {
    user: {
      id: userId,
      email: user?.primaryEmailAddress?.emailAddress,
      name: user?.firstName ? `${user.firstName} ${user.lastName || ''}`.trim() : null,
    },
  };
}

// For Gmail OAuth token retrieval (Google sign-in users only)
export async function getGoogleOAuthToken(userId: string): Promise<string | null> {
  try {
    const tokens = await clerkClient.users.getUserOauthAccessToken(userId, 'oauth_google');
    return tokens.data?.[0]?.token || null;
  } catch {
    return null;
  }
}

// Re-export for backwards compatibility with existing imports
export { getSession as auth };
