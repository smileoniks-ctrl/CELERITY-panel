/**
 * Server group model
 */

const mongoose = require('mongoose');

const serverGroupSchema = new mongoose.Schema({
    name: { type: String, required: true, unique: true, trim: true },
    description: { type: String, default: '' },
    color: { type: String, default: '#6366f1' },
    active: { type: Boolean, default: true },
    maxDevices: { type: Number, default: 0 },
    subscriptionTitle: { type: String, default: '', trim: true },
}, { timestamps: true });

serverGroupSchema.index({ active: 1 });

module.exports = mongoose.model('ServerGroup', serverGroupSchema);

