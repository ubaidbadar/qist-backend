import type { Context } from 'hono';

const MAX_USER_AGENT_LENGTH = 200;

/** Stored with refresh tokens so a user can tell their devices apart later. */
export const userAgentOf = (c: Context) => (c.req.header('User-Agent') ?? '').slice(0, MAX_USER_AGENT_LENGTH);
