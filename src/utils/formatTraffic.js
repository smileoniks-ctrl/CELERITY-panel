const GIB = 1024 * 1024 * 1024;
const MIB = 1024 * 1024;
const TB_THRESHOLD_GIB = 1024;

const DEFAULT_UNITS = Object.freeze({ GB: 'GB', TB: 'TB', MB: 'MB' });

/**
 * Format byte count for display. Uses GB by default, switches to TB at >= 1024 GiB.
 * @param {number} bytes
 * @param {{ decimals?: number|null, units?: { GB: string, TB: string, MB: string } }} [options]
 * @returns {string}
 */
function formatTraffic(bytes, options = {}) {
    const { decimals = null, units = DEFAULT_UNITS } = options;
    const n = Number(bytes);

    if (!Number.isFinite(n) || n <= 0) {
        const d = decimals ?? 1;
        return `${(0).toFixed(d)} ${units.GB}`;
    }

    const gib = n / GIB;
    if (gib >= TB_THRESHOLD_GIB) {
        const d = decimals ?? 2;
        return `${(gib / 1024).toFixed(d)} ${units.TB}`;
    }
    if (gib >= 1) {
        const d = decimals ?? 1;
        return `${gib.toFixed(d)} ${units.GB}`;
    }

    const mib = n / MIB;
    if (mib >= 1) {
        const d = decimals ?? 0;
        return `${mib.toFixed(d)} ${units.MB}`;
    }

    const d = decimals ?? 1;
    return `${gib.toFixed(d)} ${units.GB}`;
}

module.exports = { formatTraffic, GIB };
