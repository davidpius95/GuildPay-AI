/** DI token for the shared Redis client (real ioredis or in-memory fallback). */
export const REDIS_CLIENT = Symbol('REDIS_CLIENT');
