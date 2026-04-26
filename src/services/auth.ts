import { v4 as uuidv4 } from 'uuid';
import { getAccountConfig, AccountConfig } from '../config.js';

export interface Session {
  id: string;
  account: AccountConfig;
  createdAt: number;
}

// In-memory session store
const sessions = new Map<string, Session>();

/**
 * Validates credentials and creates a session if successful.
 * This acts as the MCP 'login' mechanism.
 */
export const login = async (email: string): Promise<{ sessionId: string, error?: string }> => {
  const account = getAccountConfig(email);
  
  if (!account) {
    return { sessionId: '', error: `Account ${email} not configured in environment variables.` };
  }

  // Generate a secure session token
  const sessionId = uuidv4();
  
  sessions.set(sessionId, {
    id: sessionId,
    account,
    createdAt: Date.now()
  });

  return { sessionId };
};

/**
 * Destroys a session, preventing further API access.
 */
export const logout = (sessionId: string): boolean => {
  return sessions.delete(sessionId);
};

/**
 * Retrieves the session and associated account config.
 */
export const getSession = (sessionId: string): Session | undefined => {
  return sessions.get(sessionId);
};
