/**
 * Cascade link model — represents a proxy tunnel between two Xray nodes.
 *
 * Supports two modes:
 * - 'reverse': Reverse proxy tunnel (Bridge initiates connection to Portal)
 * - 'forward': Forward proxy chain (Portal connects through Bridge via proxySettings.tag)
 *
 * Reverse mode:
 *   Portal (entry) accepts client traffic and proxies it via reverse tunnel.
 *   Bridge (exit) initiates the tunnel to Portal and releases traffic to the internet.
 *
 * Forward mode:
 *   Portal (entry) has outbound with proxySettings.tag pointing to Bridge outbound.
 *   Traffic flows: client → Portal → Bridge → internet
 *   Simpler setup, both nodes need public IPs.
 */

const mongoose = require('mongoose');

const cascadeLinkSchema = new mongoose.Schema({
    name: { type: String, required: true },

    // Cascade mode: 'reverse' (classic) or 'forward' (proxySettings.tag chain)
    mode: { type: String, enum: ['reverse', 'forward'], default: 'reverse' },

    portalNode: { type: mongoose.Schema.Types.ObjectId, ref: 'HyNode', required: true },
    bridgeNode: { type: mongoose.Schema.Types.ObjectId, ref: 'HyNode', required: true },

    tunnelUuid: { type: String, required: true },
    tunnelPort: { type: Number, default: 10086 },
    tunnelDomain: { type: String, default: 'reverse.tunnel.internal' },
    tunnelProtocol: { type: String, enum: ['vless', 'vmess'], default: 'vless' },
    tunnelSecurity: { type: String, enum: ['none', 'tls', 'reality'], default: 'none' },
    tunnelTransport: { type: String, enum: ['tcp', 'ws', 'grpc', 'xhttp'], default: 'tcp' },

    // TCP settings
    tcpFastOpen: { type: Boolean, default: true },
    tcpKeepAlive: { type: Number, default: 100 },
    tcpNoDelay: { type: Boolean, default: true },

    // WebSocket settings
    wsPath: { type: String, default: '/cascade' },
    wsHost: { type: String, default: '' },

    // gRPC settings
    grpcServiceName: { type: String, default: 'cascade' },

    // XHTTP (SplitHTTP) settings
    xhttpPath: { type: String, default: '/cascade' },
    xhttpHost: { type: String, default: '' },
    xhttpMode: { type: String, enum: ['auto', 'packet-up', 'stream-up'], default: 'auto' },

    // REALITY settings (for tunnelSecurity === 'reality')
    realityDest: { type: String, default: 'www.google.com:443' },
    realitySni: { type: [String], default: ['www.google.com'] },
    realityPrivateKey: { type: String, default: '' },
    realityPublicKey: { type: String, default: '' },
    realityShortIds: { type: [String], default: [''] },
    realityFingerprint: { type: String, default: 'chrome' },

    // MUX settings for tunnel
    muxEnabled: { type: Boolean, default: false },
    muxConcurrency: { type: Number, default: 8 },
    muxXudpConcurrency: { type: Number, default: 16 },
    muxXudpProxyUDP443: { type: String, enum: ['reject', 'allow', 'skip'], default: 'reject' },

    // Geo-routing: route specific domains/IPs through this bridge instead of the default
    geoRouting: {
        enabled: { type: Boolean, default: false },
        domains: [{ type: String }],
        geoip:   [{ type: String }],
    },

    // Lower priority value = preferred when multiple bridges are available
    priority: { type: Number, default: 100 },

    // Fallback outbound tag when this link is down (for balancer)
    fallbackTag: { type: String, default: 'direct' },

    active: { type: Boolean, default: true },
    status: {
        type: String,
        enum: ['pending', 'deployed', 'online', 'offline', 'error'],
        default: 'pending',
    },
    lastError: { type: String, default: '' },
    lastHealthCheck: { type: Date, default: null },
    latencyMs: { type: Number, default: null },
}, { timestamps: true });

cascadeLinkSchema.index({ portalNode: 1 });
cascadeLinkSchema.index({ bridgeNode: 1 });
cascadeLinkSchema.index({ active: 1, status: 1 });

module.exports = mongoose.model('CascadeLink', cascadeLinkSchema);
