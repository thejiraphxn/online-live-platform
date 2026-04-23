import IORedis from 'ioredis';
import { config } from '../config.js';

// In production, falling through to localhost means REDIS_URL wasn't wired
// up on the platform (Render, Fly, etc.) — the process will loop forever
// on ECONNREFUSED to 127.0.0.1:6379. Make that failure loud.
const isLocalhost = /^redis:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(config.redisUrl);
if (process.env.NODE_ENV === 'production' && isLocalhost) {
  // eslint-disable-next-line no-console
  console.error(
    '[redis] REDIS_URL points to localhost in production — set it to your ' +
      'managed Redis URL (Render keyvalue, Upstash, etc.). The worker and ' +
      'Socket.IO adapter will not connect.',
  );
}

export const redis = new IORedis(config.redisUrl, {
  maxRetriesPerRequest: null,
});
