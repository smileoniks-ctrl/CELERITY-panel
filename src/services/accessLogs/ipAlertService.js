/**
 * Access-logs IP-sharing alert service.
 *
 * Periodically (hourly, via cron) counts unique source IPs per user over a
 * sliding window in ClickHouse and emits a `user.ip_limit_exceeded` webhook when
 * a user crosses the configured threshold. A small in-memory state map with
 * hysteresis ensures a user is alerted once per breach instead of every run; the
 * alert re-arms only after the user's IP count drops safely back below the
 * threshold. State is intentionally in-memory (resets on restart), consistent
 * with the disk monitor and device-limit alerts.
 *
 * All heavy aggregation runs on the external ClickHouse server, so the panel
 * stays light: one small query per run, results filtered server-side via HAVING.
 *
 * Settings (settings.webhook):
 *   - ipAlertEnabled:       master toggle for this alert
 *   - ipAlertThreshold:     unique IPs per user that triggers an alert
 *   - ipAlertWindowMinutes: sliding analysis window
 *   - ipAlertIncludeIps:    attach the user's IP list to the payload (privacy opt-in)
 */

const searchService = require('./searchService');
const webhook = require('../webhookService');
const logger = require('../../utils/logger');

// Hard cap on how many IPs are attached to a payload when ipAlertIncludeIps is
// on. Keeps webhook bodies bounded regardless of how many IPs a user used.
const MAX_IPS_IN_PAYLOAD = 20;

const DEFAULT_THRESHOLD = 5;
const DEFAULT_WINDOW_MINUTES = 60;

// Per-user alert state: email -> 'ok' | 'alerted'. In-memory; resets on restart.
const _state = new Map();

function getConfig(webhookSettings) {
    const threshold = Number(webhookSettings?.ipAlertThreshold);
    const windowMinutes = Number(webhookSettings?.ipAlertWindowMinutes);
    return {
        threshold: Number.isFinite(threshold) && threshold > 0 ? Math.floor(threshold) : DEFAULT_THRESHOLD,
        windowMinutes: Number.isFinite(windowMinutes) && windowMinutes > 0 ? Math.floor(windowMinutes) : DEFAULT_WINDOW_MINUTES,
        includeIps: !!webhookSettings?.ipAlertIncludeIps,
    };
}

/**
 * Run a single check. Safe to call from a cron; never throws.
 */
async function check() {
    try {
        const { getSettings } = require('../../utils/helpers');
        const settings = await getSettings();

        const accessLogs = settings?.accessLogs || null;
        const webhookSettings = settings?.webhook || null;

        // Feature gate: access logs active, webhook enabled, and this alert on.
        if (!accessLogs?.enabled) return;
        if (!webhookSettings?.enabled || !webhookSettings?.ipAlertEnabled) return;

        const { threshold, windowMinutes, includeIps } = getConfig(webhookSettings);

        const res = await searchService.ipViolators(windowMinutes, threshold);
        if (res.degraded || res.error) return; // ClickHouse unreachable/misconfigured

        const violators = res.rows || [];
        const currentlyOver = new Set();

        for (const row of violators) {
            const email = row.email;
            if (!email) continue;
            const ips = Number(row.ips) || 0;
            currentlyOver.add(email);

            if (_state.get(email) === 'alerted') continue; // already notified this breach

            _state.set(email, 'alerted');

            let ipList;
            if (includeIps) {
                const ipRes = await searchService.ipsForUser(email, windowMinutes, MAX_IPS_IN_PAYLOAD);
                if (ipRes.rows && ipRes.rows.length) {
                    ipList = ipRes.rows.map((r) => r.ip).filter(Boolean);
                }
            }

            logger.warn(`[IpAlert] ${email} used ${ips} IPs over ${windowMinutes}m (threshold ${threshold})`);

            const data = { userId: email, ips, threshold, windowMinutes };
            if (ipList) data.ipList = ipList;
            webhook.emit(webhook.EVENTS.USER_IP_LIMIT_EXCEEDED, data);
        }

        // Re-arm users that are no longer over the threshold this run (the query
        // already applied HAVING >= threshold, so absence means recovered). This
        // also keeps the state map bounded to current violators only.
        for (const email of Array.from(_state.keys())) {
            if (!currentlyOver.has(email)) _state.delete(email);
        }
    } catch (err) {
        logger.error(`[IpAlert] check failed: ${err.message}`);
    }
}

module.exports = { check };
