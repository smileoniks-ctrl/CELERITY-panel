/**
 * Hysteria user model
 */

const mongoose = require('mongoose');
const crypto = require('crypto');

const hyUserSchema = new mongoose.Schema({
    userId: {
        type: String,
        required: true,
        unique: true,
        index: true,
    },
    
    subscriptionToken: {
        type: String,
        unique: true,
        index: true,
    },
    
    username: {
        type: String,
        default: '',
    },
    
    password: {
        type: String,
        required: true,
    },
    
    enabled: {
        type: Boolean,
        default: false,
    },
    
    groups: [{
        type: mongoose.Schema.Types.ObjectId,
        ref: 'ServerGroup',
    }],
    
    nodes: [{
        type: mongoose.Schema.Types.ObjectId,
        ref: 'HyNode',
    }],
    
    traffic: {
        tx: { type: Number, default: 0 },
        rx: { type: Number, default: 0 },
        lastUpdate: { type: Date, default: null },
    },
    
    trafficLimit: {
        type: Number,
        default: 0,
    },
    
    maxDevices: {
        type: Number,
        default: 0,
    },
    
    expireAt: {
        type: Date,
        default: null,
    },
    
}, { timestamps: true });

hyUserSchema.index({ enabled: 1 });
hyUserSchema.index({ groups: 1 });
hyUserSchema.index({ expireAt: 1 });

hyUserSchema.virtual('trafficUsedGB').get(function() {
    return ((this.traffic.tx + this.traffic.rx) / (1024 * 1024 * 1024)).toFixed(2);
});

hyUserSchema.methods.isTrafficExceeded = function() {
    if (this.trafficLimit === 0) return false;
    return (this.traffic.tx + this.traffic.rx) >= this.trafficLimit;
};

hyUserSchema.pre('save', function(next) {
    if (!this.subscriptionToken) {
        const hash = crypto.createHash('sha256')
            .update(this.userId + crypto.randomBytes(8).toString('hex'))
            .digest('hex')
            .substring(0, 16);
        this.subscriptionToken = hash;
    }
    next();
});

hyUserSchema.statics.findByToken = function(token) {
    return this.findOne({ subscriptionToken: token });
};

module.exports = mongoose.model('HyUser', hyUserSchema);

