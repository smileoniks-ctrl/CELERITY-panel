/**
 * Pure helpers for user-activity decisions.
 *
 * Single source of truth for "is this user expired / over their limit /
 * should they be auto-enabled on renewal". Reused from edit routes (REST,
 * panel, MCP) and the expire scheduler.
 */

function isExpired(user, now = new Date()) {
    if (!user || !user.expireAt) return false;
    const at = user.expireAt instanceof Date ? user.expireAt : new Date(user.expireAt);
    return at.getTime() <= now.getTime();
}

function isOverLimit(user) {
    if (!user || !user.trafficLimit || user.trafficLimit <= 0) return false;
    const used = (user.traffic?.tx || 0) + (user.traffic?.rx || 0);
    return used >= user.trafficLimit;
}

/**
 * Compute the final `enabled` value for a save based on previous state and
 * the incoming updates. Auto-reenables a previously-disabled user only when
 * the admin (or billing) actually **extended** `expireAt` or **raised**
 * `trafficLimit` (or cleared either to "no limit"). Mere presence of a key
 * in `updates` with the same value does NOT trigger auto-enable — that would
 * silently revive users an admin disabled by hand whenever the form is
 * re-saved. Explicit `updates.enabled` always wins.
 *
 * @param {object} prev    existing user document (plain or Mongoose .toObject())
 * @param {object} updates fields about to be persisted ($set-style merge)
 * @returns {boolean} final enabled value
 */
function recomputeEnabled(prev, updates) {
    const explicit = updates.enabled !== undefined;

    const merged = {
        enabled: explicit ? updates.enabled : prev.enabled,
        expireAt: updates.expireAt !== undefined ? updates.expireAt : prev.expireAt,
        trafficLimit: updates.trafficLimit !== undefined ? updates.trafficLimit : prev.trafficLimit,
        traffic: prev.traffic,
    };

    if (explicit || prev.enabled !== false) return merged.enabled;

    // Only count as renewal if the relevant factor *moved in the user's favor*.
    const prevExpireMs = prev.expireAt ? new Date(prev.expireAt).getTime() : null;
    const newExpireMs = merged.expireAt ? new Date(merged.expireAt).getTime() : null;
    const expireExtended =
        updates.expireAt !== undefined && (
            // null -> set in the future
            (prevExpireMs === null && newExpireMs !== null) ||
            // set -> later
            (prevExpireMs !== null && newExpireMs !== null && newExpireMs > prevExpireMs) ||
            // set -> null (no expiry at all)
            (prevExpireMs !== null && newExpireMs === null)
        );

    const prevLimit = prev.trafficLimit || 0;
    const newLimit = merged.trafficLimit || 0;
    const limitRaised =
        updates.trafficLimit !== undefined && (
            (prevLimit > 0 && newLimit === 0) ||  // -> unlimited
            (newLimit > prevLimit)                // raised
        );

    const renewal = expireExtended || limitRaised;
    if (renewal && !isExpired(merged) && !isOverLimit(merged)) return true;

    return merged.enabled;
}

module.exports = {
    isExpired,
    isOverLimit,
    recomputeEnabled,
};
