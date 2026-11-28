import {
  parseDeviceName,
  tokenExpiries,
  type Session,
  type SessionTokenPair,
  type SignInMethod,
} from '@hk/core/identity/domain';
import type { Clock } from '@hk/platform/universal';
import type { SessionRepository, TokenCodec } from './ports';

/**
 * Starting a session and making token pairs. Shared by every way of
 * signing in: password, one-time code, passkey.
 */

/**
 * What a person holds after signing in or refreshing. The two tokens are
 * secrets: they are returned once, here, and never stored or logged by the
 * server.
 */
export interface SessionTokens {
  userId: string;
  sessionId: string;
  accessToken: string;
  /** ISO 8601 instant after which the access token no longer works. */
  accessExpiresAt: string;
  refreshToken: string;
  /** ISO 8601 instant after which the refresh token no longer works. */
  refreshExpiresAt: string;
}

export interface SessionStarterOptions {
  sessions: SessionRepository;
  tokenCodec: TokenCodec;
  clock: Clock;
  newId: () => string;
}

export interface SessionStarter {
  /** A new pair for a session, with the tokens themselves to hand back. */
  mintPair(
    session: Session,
    parentId: string | null,
    now: Date,
  ): { pair: SessionTokenPair; tokens: SessionTokens };
  /**
   * Starts a session for a person who has just proved who they are. Runs
   * inside the caller's unit of work, so it commits or not with whatever
   * proved it (a one-time code being used up, a passkey's count moving).
   */
  startSession(
    userId: string,
    method: SignInMethod,
    deviceName: unknown,
  ): Promise<SessionTokens>;
}

export const createSessionStarter = (
  options: SessionStarterOptions,
): SessionStarter => {
  const { sessions, tokenCodec, clock, newId } = options;

  const mintPair: SessionStarter['mintPair'] = (session, parentId, now) => {
    const accessToken = tokenCodec.generate('access');
    const refreshToken = tokenCodec.generate('refresh');
    const expiries = tokenExpiries(now);
    return {
      pair: {
        id: newId(),
        sessionId: session.id,
        parentId,
        accessHash: tokenCodec.hash(accessToken),
        refreshHash: tokenCodec.hash(refreshToken),
        issuedAt: now.toISOString(),
        ...expiries,
        rotatedAt: null,
      },
      tokens: {
        userId: session.userId,
        sessionId: session.id,
        accessToken,
        refreshToken,
        ...expiries,
      },
    };
  };

  const startSession: SessionStarter['startSession'] = async (
    userId,
    method,
    deviceName,
  ) => {
    const now = clock.now();
    const session: Session = {
      id: newId(),
      userId,
      method,
      deviceName: parseDeviceName(deviceName),
      createdAt: now.toISOString(),
      lastUsedAt: now.toISOString(),
      revokedAt: null,
      revokeReason: null,
    };
    const { pair, tokens } = mintPair(session, null, now);
    await sessions.create(session, pair);
    return tokens;
  };

  return { mintPair, startSession };
};
