import { Webhook } from 'svix';
import { headers } from 'next/headers';
import { WebhookEvent } from '@clerk/nextjs/server';
import { db } from '@/db';
import { connections } from '@/db/schema';
import { createClerkClient } from '@clerk/nextjs/server';
import { encryptCredentials, OAuthCredentials } from '@/lib/crypto';
import { eq, and } from 'drizzle-orm';

const clerkClient = createClerkClient({
  secretKey: process.env.CLERK_SECRET_KEY,
});

export async function POST(req: Request) {
  // Get the headers
  const headerPayload = await headers();
  const svix_id = headerPayload.get('svix-id');
  const svix_timestamp = headerPayload.get('svix-timestamp');
  const svix_signature = headerPayload.get('svix-signature');

  // If there are no headers, error out
  if (!svix_id || !svix_timestamp || !svix_signature) {
    return new Response('Missing svix headers', { status: 400 });
  }

  // Get the body
  const payload = await req.json();
  const body = JSON.stringify(payload);

  // Create a new Svix instance with your secret
  const webhookSecret = process.env.CLERK_WEBHOOK_SECRET;
  if (!webhookSecret) {
    console.error('CLERK_WEBHOOK_SECRET not configured');
    return new Response('Webhook secret not configured', { status: 500 });
  }

  const wh = new Webhook(webhookSecret);

  let evt: WebhookEvent;

  // Verify the payload with the headers
  try {
    evt = wh.verify(body, {
      'svix-id': svix_id,
      'svix-timestamp': svix_timestamp,
      'svix-signature': svix_signature,
    }) as WebhookEvent;
  } catch (err) {
    console.error('Error verifying webhook:', err);
    return new Response('Error verifying webhook', { status: 400 });
  }

  // Handle the webhook
  const eventType = evt.type;

  if (eventType === 'user.created' || eventType === 'session.created') {
    try {
      // Get the user ID from the event
      const userId = 'user_id' in evt.data ? evt.data.user_id : evt.data.id;
      if (!userId) {
        console.error('No user ID in webhook event');
        return new Response('OK', { status: 200 });
      }

      // Get the user details from Clerk
      const user = await clerkClient.users.getUser(userId);

      // Check if user signed in with Google
      const googleAccount = user.externalAccounts.find(
        (account) => account.provider === 'oauth_google'
      );

      if (!googleAccount) {
        // Not a Google sign-in, nothing to do
        return new Response('OK', { status: 200 });
      }

      // Check if Gmail connection already exists
      const existingConnection = await db
        .select()
        .from(connections)
        .where(
          and(
            eq(connections.userId, userId),
            eq(connections.platform, 'gmail')
          )
        )
        .limit(1);

      if (existingConnection.length > 0) {
        // Already have a Gmail connection
        return new Response('OK', { status: 200 });
      }

      // Get OAuth access token from Clerk
      const tokens = await clerkClient.users.getUserOauthAccessToken(
        userId,
        'oauth_google'
      );

      if (!tokens.data?.[0]?.token) {
        console.error('No OAuth token available for user:', userId);
        return new Response('OK', { status: 200 });
      }

      // Create Gmail connection with encrypted OAuth tokens
      const oauthCreds: OAuthCredentials = {
        accessToken: tokens.data[0].token,
        refreshToken: '', // Clerk handles token refresh
        expiresAt: 0, // Clerk manages expiration
      };

      await db.insert(connections).values({
        userId,
        platform: 'gmail',
        authType: 'oauth',
        credentials: encryptCredentials(oauthCreds),
        status: 'active',
      });

      console.log('Created Gmail connection for user:', userId);
    } catch (error) {
      console.error('Error processing webhook:', error);
      // Don't return error - webhook should succeed even if processing fails
    }
  }

  return new Response('OK', { status: 200 });
}
