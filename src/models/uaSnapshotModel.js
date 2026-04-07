const mongoose = require('mongoose');

// Stores daily unique-user counts per VPN client, derived from Redis HyperLogLog.
// One document per day; retention is 90 days (cleaned up by the daily cron).
const uaSnapshotSchema = new mongoose.Schema({
    date: {
        type: Date,
        required: true,
        unique: true,
    },

    // Map of client name -> approximate unique user count (from HLL PFCOUNT)
    clients: {
        happ:         { type: Number, default: 0 },
        hiddify:      { type: Number, default: 0 },
        v2rayng:      { type: Number, default: 0 },
        shadowrocket: { type: Number, default: 0 },
        streisand:    { type: Number, default: 0 },
        nekobox:      { type: Number, default: 0 },
        singbox:      { type: Number, default: 0 },
        clash:        { type: Number, default: 0 },
        quantumult:   { type: Number, default: 0 },
        other:        { type: Number, default: 0 },
    },

    // Sum of all client counts (approximate; HLL union not computed)
    total: { type: Number, default: 0 },

}, {
    timestamps: false,
    versionKey: false,
});

/**
 * Get snapshots for the last N days (excluding today — today comes from Redis live).
 * @param {number} days
 */
uaSnapshotSchema.statics.getRecent = async function(days) {
    const since = new Date();
    since.setUTCHours(0, 0, 0, 0);
    since.setUTCDate(since.getUTCDate() - days);
    return this.find({ date: { $gte: since } })
        .sort({ date: 1 })
        .lean();
};

/**
 * Remove snapshots older than 90 days.
 */
uaSnapshotSchema.statics.cleanup = async function() {
    const cutoff = new Date();
    cutoff.setUTCDate(cutoff.getUTCDate() - 90);
    const result = await this.deleteMany({ date: { $lt: cutoff } });
    return result.deletedCount;
};

module.exports = mongoose.model('UaSnapshot', uaSnapshotSchema);
