/**
 * Hysteria 2 config generator
 */

const yaml = require('yaml');

/**
 * Generate YAML config for Hysteria 2 node
 * @param {Object} node - Node configuration
 * @param {string} authUrl - Auth API URL
 * @param {Object} options - Additional options
 * @param {boolean} options.authInsecure - Allow self-signed certs for auth API (default: true)
 * @param {boolean} options.useTlsFiles - Force using TLS files instead of ACME (for same-VPS setup)
 */
function generateNodeConfig(node, authUrl, options = {}) {
    const { authInsecure = true, useTlsFiles = false } = options;
    
    const config = {
        listen: `:${node.port}`,
        
        sniff: {
            enable: true,
            timeout: '2s',
            rewriteDomain: false,
            tcpPorts: '80,443,8000-9000',
            udpPorts: '443,80,53',
        },
        
        quic: {
            initStreamReceiveWindow: 8388608,
            maxStreamReceiveWindow: 8388608,
            initConnReceiveWindow: 20971520,
            maxConnReceiveWindow: 20971520,
            maxIdleTimeout: '60s',
            maxIncomingStreams: 256,
            disablePathMTUDiscovery: false,
        },
        
        auth: {
            type: 'http',
            http: {
                url: authUrl,
                insecure: authInsecure,
            },
        },
        
        ignoreClientBandwidth: false,
        
        masquerade: {
            type: 'proxy',
            proxy: {
                url: 'https://www.google.com',
                rewriteHost: true,
            },
        },
        
        acl: {
            inline: [
                'reject(geoip:cn)',
                'reject(geoip:private)',
            ],
        },
    };
    
    if (node.domain && !useTlsFiles) {
        // ACME - SNI must match domain (sniGuard: dns-san by default)
        config.acme = {
            domains: [node.domain],
            email: 'acme@' + node.domain,
            ca: 'letsencrypt',
            listenHost: '0.0.0.0',
        };
    } else {
        // TLS with certificate files (self-signed or copied from panel)
        config.tls = {
            cert: node.paths?.cert || '/etc/hysteria/cert.pem',
            key: node.paths?.key || '/etc/hysteria/key.pem',
        };
        // If custom SNI is set, disable sniGuard to allow domain fronting
        if (node.sni) {
            config.tls.sniGuard = 'disable';
        }
    }
    
    if (node.statsPort && node.statsSecret) {
        config.trafficStats = {
            listen: `:${node.statsPort}`,
            secret: node.statsSecret,
        };
    }
    
    applyOutboundsAndAcl(config, node);
    
    return yaml.stringify(config);
}

/**
 * Apply outbounds and ACL rules from node settings to config object
 * @param {Object} config - Hysteria config object (mutated in place)
 * @param {Object} node - Node with outbounds and aclRules fields
 */
function applyOutboundsAndAcl(config, node) {
    const customOutbounds = node.outbounds || [];
    const customAclRules = node.aclRules || [];
    
    // In Hysteria 2, valid outbound types are: direct, socks5, http
    // 'block' type is not a real outbound — 'reject' is a built-in ACL action
    const realOutbounds = customOutbounds.filter(ob => ob.type !== 'block');
    
    if (realOutbounds.length > 0) {
        config.outbounds = realOutbounds.map(ob => {
            const entry = { name: ob.name, type: ob.type };
            if (ob.type === 'socks5') {
                // SOCKS5 format: { addr, username?, password? }
                const proxyConfig = { addr: ob.addr };
                if (ob.username) proxyConfig.username = ob.username;
                if (ob.password) proxyConfig.password = ob.password;
                entry.socks5 = proxyConfig;
            } else if (ob.type === 'http') {
                // HTTP format: { url, insecure? }
                // url can include auth: http://user:pass@host:port
                let url = ob.addr;
                if (!url.startsWith('http://') && !url.startsWith('https://')) {
                    url = 'http://' + url;
                }
                if (ob.username && ob.password) {
                    // Insert auth into URL: http://user:pass@host:port
                    const urlObj = new URL(url);
                    urlObj.username = ob.username;
                    urlObj.password = ob.password;
                    url = urlObj.toString();
                }
                entry.http = { url };
            }
            return entry;
        });
    }
    
    if (customAclRules.length > 0) {
        // 'block' is not a valid ACL action in Hysteria 2 — replace with 'reject'
        const normalizedRules = customAclRules.map(r => r.replace(/\bblock\(/g, 'reject('));
        config.acl = { inline: normalizedRules };
    }
}

/**
 * Generate config with ACME (Let's Encrypt)
 * @param {Object} node - Node configuration
 * @param {string} authUrl - Auth API URL
 * @param {string} domain - ACME domain
 * @param {string} email - ACME email
 * @param {Object} options - Additional options
 * @param {boolean} options.authInsecure - Allow self-signed certs for auth API (default: true)
 */
function generateNodeConfigACME(node, authUrl, domain, email, options = {}) {
    const { authInsecure = true } = options;
    
    const config = {
        listen: `:${node.port}`,
        
        acme: {
            domains: [domain],
            email: email,
        },
        
        sniff: {
            enable: true,
            timeout: '2s',
            rewriteDomain: false,
            tcpPorts: '80,443,8000-9000',
            udpPorts: '443,80,53',
        },
        
        quic: {
            initStreamReceiveWindow: 8388608,
            maxStreamReceiveWindow: 8388608,
            initConnReceiveWindow: 20971520,
            maxConnReceiveWindow: 20971520,
            maxIdleTimeout: '60s',
            maxIncomingStreams: 256,
            disablePathMTUDiscovery: false,
        },
        
        auth: {
            type: 'http',
            http: {
                url: authUrl,
                insecure: authInsecure,
            },
        },
        
        ignoreClientBandwidth: false,
        
        masquerade: {
            type: 'proxy',
            proxy: {
                url: 'https://www.google.com',
                rewriteHost: true,
            },
        },
        
        acl: {
            inline: [
                'reject(geoip:cn)',
                'reject(geoip:private)',
            ],
        },
    };
    
    if (node.statsPort && node.statsSecret) {
        config.trafficStats = {
            listen: `:${node.statsPort}`,
            secret: node.statsSecret,
        };
    }
    
    applyOutboundsAndAcl(config, node);
    
    return yaml.stringify(config);
}

/**
 * Generate systemd service file for Hysteria
 */
function generateSystemdService() {
    return `[Unit]
Description=Hysteria 2 Server
After=network.target

[Service]
Type=simple
ExecStart=/usr/local/bin/hysteria server -c /etc/hysteria/config.yaml
Restart=always
RestartSec=3
LimitNOFILE=1048576

[Install]
WantedBy=multi-user.target
`;
}

// ==================== XRAY ====================

/**
 * Build Xray streamSettings object based on node transport/security config
 * @param {Object} node - Node with xray sub-object
 * @returns {Object} streamSettings
 */
function buildXrayStreamSettings(node) {
    const xray = node.xray || {};
    const transport = xray.transport || 'tcp';
    const security = xray.security || 'reality';

    const streamSettings = { network: transport };

    // Security layer
    if (security === 'reality') {
        streamSettings.security = 'reality';
        streamSettings.realitySettings = {
            dest: xray.realityDest || 'www.google.com:443',
            serverNames: xray.realitySni && xray.realitySni.length > 0
                ? xray.realitySni
                : ['www.google.com'],
            privateKey: xray.realityPrivateKey || '',
            shortIds: xray.realityShortIds && xray.realityShortIds.length > 0
                ? xray.realityShortIds
                : [''],
            spiderX: xray.realitySpiderX || '/',
        };
    } else if (security === 'tls') {
        streamSettings.security = 'tls';
        streamSettings.tlsSettings = {
            serverName: node.domain || node.sni || '',
            certificates: [{
                certificateFile: node.paths?.cert || '/etc/xray/cert.pem',
                keyFile: node.paths?.key || '/etc/xray/key.pem',
            }],
        };
    } else {
        streamSettings.security = 'none';
    }

    // Transport-specific settings
    if (transport === 'ws') {
        streamSettings.wsSettings = {
            path: xray.wsPath || '/',
            headers: xray.wsHost ? { Host: xray.wsHost } : {},
        };
    } else if (transport === 'grpc') {
        streamSettings.grpcSettings = {
            serviceName: xray.grpcServiceName || 'grpc',
        };
    }

    return streamSettings;
}

/**
 * Generate Xray JSON config for a node with all its users
 * @param {Object} node - Node document (with xray sub-object)
 * @param {Array} users - Array of user documents (with xrayUuid)
 * @returns {string} JSON string
 */
function generateXrayConfig(node, users) {
    const xray = node.xray || {};
    const apiPort = xray.apiPort || 61000;
    const inboundTag = xray.inboundTag || 'vless-in';
    const transport = xray.transport || 'tcp';
    const security = xray.security || 'reality';

    // Build clients list from users
    const clients = (users || []).map(u => {
        const client = {
            id: u.xrayUuid,
            email: `${u.userId}.${u.username || 'user'}`,
            level: 0,
        };
        // flow only makes sense for tcp+reality or tcp+tls
        if ((security === 'reality' || security === 'tls') && transport === 'tcp') {
            client.flow = xray.flow || 'xtls-rprx-vision';
        }
        return client;
    });

    const config = {
        log: {
            loglevel: 'warning',
        },
        api: {
            services: ['HandlerService', 'StatsService'],
            tag: 'API',
        },
        stats: {},
        policy: {
            levels: {
                '0': {
                    statsUserUplink: true,
                    statsUserDownlink: true,
                },
            },
            system: {
                statsInboundUplink: true,
                statsInboundDownlink: true,
            },
        },
        inbounds: [
            // gRPC API inbound (local only, for user management)
            {
                listen: '127.0.0.1',
                port: apiPort,
                protocol: 'dokodemo-door',
                settings: { address: '127.0.0.1' },
                tag: 'API_INBOUND',
            },
            // VLESS inbound
            {
                listen: '0.0.0.0',
                port: node.port || 443,
                protocol: 'vless',
                tag: inboundTag,
                settings: {
                    clients,
                    decryption: 'none',
                },
                streamSettings: buildXrayStreamSettings(node),
                sniffing: {
                    enabled: true,
                    destOverride: ['http', 'tls', 'quic'],
                    routeOnly: true,
                },
            },
        ],
        outbounds: [
            { protocol: 'freedom', tag: 'direct' },
            { protocol: 'blackhole', tag: 'block' },
        ],
        routing: {
            domainStrategy: 'IPIfNonMatch',
            rules: [
                // Route API traffic to API service
                {
                    inboundTag: ['API_INBOUND'],
                    outboundTag: 'API',
                    type: 'field',
                },
                // Block private IPs
                {
                    type: 'field',
                    ip: ['geoip:private'],
                    outboundTag: 'block',
                },
            ],
        },
    };

    return JSON.stringify(config, null, 2);
}

/**
 * Generate systemd service file for Xray
 */
function generateXraySystemdService() {
    return `[Unit]
Description=Xray Service
After=network.target nss-lookup.target

[Service]
User=nobody
CapabilityBoundingSet=CAP_NET_ADMIN CAP_NET_BIND_SERVICE
AmbientCapabilities=CAP_NET_ADMIN CAP_NET_BIND_SERVICE
NoNewPrivileges=true
Type=simple
ExecStart=/usr/local/bin/xray run -config /etc/xray/config.json
Restart=on-failure
RestartSec=5
LimitNOFILE=1048576

[Install]
WantedBy=multi-user.target
`;
}

module.exports = {
    generateNodeConfig,
    generateNodeConfigACME,
    generateSystemdService,
    applyOutboundsAndAcl,
    generateXrayConfig,
    buildXrayStreamSettings,
    generateXraySystemdService,
};
