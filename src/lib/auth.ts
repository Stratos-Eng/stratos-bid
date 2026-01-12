import NextAuth from 'next-auth';
import Google from 'next-auth/providers/google';
import { DrizzleAdapter } from '@auth/drizzle-adapter';
import { db } from '@/db';
import { connections, accounts } from '@/db/schema';
import { encryptCredentials, OAuthCredentials } from '@/lib/crypto';
import { eq, and } from 'drizzle-orm';

export const { handlers, signIn, signOut, auth } = NextAuth({
  adapter: DrizzleAdapter(db),
  providers: [
    Google({
      clientId: process.env.GOOGLE_CLIENT_ID!,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
      authorization: {
        params: {
          prompt: 'consent',
          access_type: 'offline',
          response_type: 'code',
          scope: 'openid email profile https://www.googleapis.com/auth/gmail.readonly',
        },
      },
    }),
  ],
  callbacks: {
    session({ session, user }) {
      if (session.user) {
        session.user.id = user.id;
      }
      return session;
    },
  },
  events: {
    async signIn({ user }) {
      // On every sign-in, ensure Gmail connection exists for Google users
      if (!user.id) return;

      // Check if Gmail connection already exists
      const existingConnection = await db
        .select()
        .from(connections)
        .where(
          and(
            eq(connections.userId, user.id),
            eq(connections.platform, 'gmail')
          )
        )
        .limit(1);

      if (existingConnection.length > 0) return; // Already have connection

      // Get the Google account tokens
      const [googleAccount] = await db
        .select()
        .from(accounts)
        .where(
          and(
            eq(accounts.userId, user.id),
            eq(accounts.provider, 'google')
          )
        )
        .limit(1);

      if (!googleAccount?.access_token) return;

      // Create Gmail connection with encrypted OAuth tokens
      const oauthCreds: OAuthCredentials = {
        accessToken: googleAccount.access_token,
        refreshToken: googleAccount.refresh_token || '',
        expiresAt: (googleAccount.expires_at || 0) * 1000,
      };

      await db.insert(connections).values({
        userId: user.id,
        platform: 'gmail',
        authType: 'oauth',
        credentials: encryptCredentials(oauthCreds),
        status: 'active',
      });
    },
  },
});
