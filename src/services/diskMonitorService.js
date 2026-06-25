/**
 * Disk monitor service
 *
 * Periodically checks free space on the panel host filesystem and emits
 * webhook alerts when it crosses configurable thresholds. Uses a small state
 * machine (ok -> low -> critical) with hysteresis so alerts fire once per
 * level change instead of every cycle, and a recovery event is only sent once
 * free space climbs back above the warning threshold with a safety margin.
 *
 * Thresholds (from settings.webhook):
 *   - diskWarnPct: warn when free space percent drops below this value
 *   - diskCritGb:  critical when free space drops below this many GiB
 */

const hostMetrics = require('./hostMetricsService');
const webhook = require('./webhookService');
const logger = require('../utils/logger');

const GIB = 1024 * 1024 * 1024;
const DISK_PATH = process.env.DISK_MONITOR_PATH || '/';

// Hysteresis margins to avoid flapping near a threshold.
const RECOVER_MARGIN_PCT = 5;        // free% must exceed warn + this to clear "low"
const RECOVER_MARGIN_FACTOR = 2;     // freeBytes must exceed crit * this to leave "critical"

const DEFAULT_WARN_PCT = 15;
const DEFAULT_CRIT_GB = 1;

// Current alert level: 'ok' | 'low' | 'critical'. In-memory; resets on restart.
let _level = 'ok';

function getThresholds(webhookSettings) {
    const warnPct = Number(webhookSettings?.diskWarnPct);
    const critGb = Number(webhookSettings?.diskCritGb);
    return {
        warnPct: Number.isFinite(warnPct) && warnPct > 0 ? warnPct : DEFAULT_WARN_PCT,
        critBytes: (Number.isFinite(critGb) && critGb > 0 ? critGb : DEFAULT_CRIT_GB) * GIB,
    };
}

// Compute the next level from the previous one with hysteresis.
function nextLevel(prev, freeBytes, freePct, warnPct, critBytes) {
    const recoverPct = warnPct + RECOVER_MARGIN_PCT;
    const recoverBytes = critBytes * RECOVER_MARGIN_FACTOR;

    switch (prev) {
        case 'critical':
            if (freeBytes >= recoverBytes && freePct >= recoverPct) return 'ok';
            if (freeBytes >= recoverBytes) return 'low';
            return 'critical';
        case 'low':
            if (freeBytes < critBytes) return 'critical';
            if (freePct >= recoverPct) return 'ok';
            return 'low';
        case 'ok':
        default:
            if (freeBytes < critBytes) return 'critical';
            if (freePct < warnPct) return 'low';
            return 'ok';
    }
}

function eventForTransition(from, to) {
    if (to === 'critical') return webhook.EVENTS.HOST_DISK_CRITICAL;
    if (to === 'low') return webhook.EVENTS.HOST_DISK_LOW;
    if (to === 'ok' && from !== 'ok') return webhook.EVENTS.HOST_DISK_RECOVERED;
    return null;
}

/**
 * Run a single check. Safe to call from a cron; never throws.
 */
async function check() {
    try {
        const { getSettings } = require('../utils/helpers');
        const settings = await getSettings();
        const webhookSettings = settings?.webhook || null;

        const snap = hostMetrics.getSnapshot();
        if (!snap.diskTotal) return; // no statfs data yet

        const freeBytes = snap.diskFree;
        const usedPct = snap.diskPct;
        const freePct = 100 - usedPct;

        const { warnPct, critBytes } = getThresholds(webhookSettings);
        const from = _level;
        const to = nextLevel(from, freeBytes, freePct, warnPct, critBytes);

        if (to === from) return;

        _level = to;
        const event = eventForTransition(from, to);
        if (!event) return;

        logger.warn(`[DiskMonitor] ${DISK_PATH} ${from} -> ${to} (free ${(freeBytes / GIB).toFixed(2)} GiB, used ${usedPct}%)`);

        webhook.emit(event, {
            path: DISK_PATH,
            freeBytes,
            totalBytes: snap.diskTotal,
            usedPct,
            level: to,
        });
    } catch (err) {
        logger.error(`[DiskMonitor] check failed: ${err.message}`);
    }
}

module.exports = { check };
