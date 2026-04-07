const UaSnapshot = require('../models/uaSnapshotModel');
const cache = require('./cacheService');
const logger = require('../utils/logger');

// Ordered list for consistent matching (Hiddify before Clash — its UA contains "ClashMeta")
const CLIENT_PATTERNS = [
    { name: 'happ',         re: /happ/i },
    { name: 'hiddify',      re: /hiddify/i },
    { name: 'nekobox',      re: /nekobox|nekoray/i },
    { name: 'singbox',      re: /sing-?box|sfa|sfi|sfm|sft|karing/i },
    { name: 'v2rayng',      re: /v2rayng|v2rayn/i },
    { name: 'shadowrocket', re: /shadowrocket/i },
    { name: 'streisand',    re: /streisand/i },
    { name: 'clash',        re: /clash|stash|surge|loon/i },
    { name: 'quantumult',   re: /quantumult/i },
];

const CLIENT_NAMES = CLIENT_PATTERNS.map(p => p.name).concat('other');

const CACHE_TTL_SECONDS = 60;

/**
 * Detect VPN client name from User-Agent string.
 * Returns one of the CLIENT_NAMES values.
 * @param {string} ua
 * @returns {string}
 */
function detectClient(ua) {
    const str = ua || '';
    for (const { name, re } of CLIENT_PATTERNS) {
        if (re.test(str)) return name;
    }
    return 'other';
}

/**
 * Build the Redis HLL key for a given date string and client name.
 * @param {string} dateStr  e.g. "2026-04-07"
 * @param {string} client
 * @returns {string}
 */
function hllKey(dateStr, client) {
    return `ua:${dateStr}:${client}`;
}

/**
 * Get today's UTC date string (YYYY-MM-DD).
 * @returns {string}
 */
function todayStr() {
    return new Date().toISOString().slice(0, 10);
}

/**
 * Get yesterday's UTC date string (YYYY-MM-DD).
 * @returns {string}
 */
function yesterdayStr() {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - 1);
    return d.toISOString().slice(0, 10);
}

class UaStatsService {
    /**
     * Track a subscription request. Fire-and-forget — never throws.
     * Skips silently if Redis is not connected.
     * @param {string} token  subscription token (used as HLL element)
     * @param {string} userAgent
     */
    track(token, userAgent) {
        if (!cache.isConnected()) return;
        const client = detectClient(userAgent);
        const key = hllKey(todayStr(), client);
        // Fire-and-forget — intentionally not awaited
        cache.redis.pfadd(key, token).catch(() => {});
    }

    /**
     * Get today's unique user counts from Redis via a single pipeline call.
     * Returns an object { happ: N, hiddify: N, ..., total: N } or null on error.
     */
    async getTodayStats() {
        if (!cache.isConnected()) return null;
        try {
            const date = todayStr();
            const pipeline = cache.redis.pipeline();
            for (const name of CLIENT_NAMES) {
                pipeline.pfcount(hllKey(date, name));
            }
            const results = await pipeline.exec();
            const clients = {};
            let total = 0;
            CLIENT_NAMES.forEach((name, i) => {
                const count = (results[i] && results[i][1]) ? results[i][1] : 0;
                clients[name] = count;
                total += count;
            });
            return { date, clients, total };
        } catch (err) {
            logger.error(`[UaStats] getTodayStats error: ${err.message}`);
            return null;
        }
    }

    /**
     * Get historical UA stats from MongoDB for the past N days.
     * Does NOT include today (today comes from Redis live via getTodayStats).
     * @param {number} days
     * @returns {Promise<Array>}
     */
    async getHistoricalStats(days) {
        try {
            return await UaSnapshot.getRecent(days);
        } catch (err) {
            logger.error(`[UaStats] getHistoricalStats error: ${err.message}`);
            return [];
        }
    }

    /**
     * Flush yesterday's Redis HLL counts to MongoDB and delete the Redis keys.
     * Idempotent — safe to call multiple times.
     */
    async flushYesterday() {
        if (!cache.isConnected()) {
            logger.warn('[UaStats] flushYesterday: Redis not connected, skipping');
            return;
        }
        try {
            const date = yesterdayStr();

            const pipeline = cache.redis.pipeline();
            for (const name of CLIENT_NAMES) {
                pipeline.pfcount(hllKey(date, name));
            }
            const results = await pipeline.exec();

            const clients = {};
            let total = 0;
            CLIENT_NAMES.forEach((name, i) => {
                const count = (results[i] && results[i][1]) ? results[i][1] : 0;
                clients[name] = count;
                total += count;
            });

            // Only persist if there was any activity
            if (total > 0) {
                const utcDate = new Date(date + 'T00:00:00.000Z');
                await UaSnapshot.findOneAndUpdate(
                    { date: utcDate },
                    { $set: { clients, total, date: utcDate } },
                    { upsert: true }
                );
                logger.info(`[UaStats] Flushed ${total} UA events for ${date}`);
            }

            // Remove Redis keys regardless (cleanup even if no activity)
            const delPipeline = cache.redis.pipeline();
            for (const name of CLIENT_NAMES) {
                delPipeline.unlink(hllKey(date, name));
            }
            await delPipeline.exec();

        } catch (err) {
            logger.error(`[UaStats] flushYesterday error: ${err.message}`);
        }
    }

    /**
     * Aggregate stats across N days: today (Redis) + past days (MongoDB).
     * Returns { totals: { happ: N, ... }, byDay: [...], total: N }.
     * Result is cached in Redis for CACHE_TTL_SECONDS seconds.
     * @param {number} days  1-90
     */
    async getAggregated(days) {
        const cacheKey = `stats:clients:${days}`;
        if (cache.isConnected()) {
            try {
                const hit = await cache.redis.get(cacheKey);
                if (hit) return JSON.parse(hit);
            } catch (e) {}
        }

        const [todayData, historical] = await Promise.all([
            this.getTodayStats(),
            days > 1 ? this.getHistoricalStats(days - 1) : Promise.resolve([]),
        ]);

        const totals = {};
        CLIENT_NAMES.forEach(n => { totals[n] = 0; });

        const byDay = [];

        // Historical days from MongoDB
        for (const snap of historical) {
            const row = { date: snap.date, clients: {}, total: snap.total || 0 };
            CLIENT_NAMES.forEach(n => {
                const v = (snap.clients && snap.clients[n]) ? snap.clients[n] : 0;
                row.clients[n] = v;
                totals[n] += v;
            });
            byDay.push(row);
        }

        // Today from Redis
        if (todayData) {
            byDay.push(todayData);
            CLIENT_NAMES.forEach(n => { totals[n] += todayData.clients[n] || 0; });
        }

        const total = CLIENT_NAMES.reduce((s, n) => s + totals[n], 0);
        const result = { totals, byDay, total };

        if (cache.isConnected()) {
            try {
                await cache.redis.setex(cacheKey, CACHE_TTL_SECONDS, JSON.stringify(result));
            } catch (e) {}
        }

        return result;
    }

    /**
     * Remove UaSnapshot records older than 90 days.
     */
    async cleanup() {
        try {
            const deleted = await UaSnapshot.cleanup();
            if (deleted > 0) logger.info(`[UaStats] Cleanup: removed ${deleted} old snapshots`);
            return deleted;
        } catch (err) {
            logger.error(`[UaStats] cleanup error: ${err.message}`);
            return 0;
        }
    }
}

module.exports = new UaStatsService();
module.exports.detectClient = detectClient;
module.exports.CLIENT_NAMES = CLIENT_NAMES;
