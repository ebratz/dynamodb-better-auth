import { createAuthClient } from "better-auth/react";

/**
 * Shared auth client for client-side hooks (useSession, signIn, signOut, signUp).
 * Creates a single instance used by all components in the app.
 */
export const authClient = createAuthClient();
