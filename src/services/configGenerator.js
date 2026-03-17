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
    
    if (node.obfs?.password) {
        config.obfs = {
            type: 'salamander',
            salamander: { password: node.obfs.password },
        };
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
    
    if (node.obfs?.password) {
        config.obfs = {
            type: 'salamander',
            salamander: { password: node.obfs.password },
        };
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

    // xhttp is called 'splithttp' in Xray config network field
    const networkName = transport === 'xhttp' ? 'splithttp' : transport;
    const streamSettings = { network: networkName };

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
                certificateFile: node.paths?.cert || '/usr/local/etc/xray/cert.pem',
                keyFile: node.paths?.key || '/usr/local/etc/xray/key.pem',
            }],
        };
        // Add ALPN if specified
        if (xray.alpn && xray.alpn.length > 0) {
            streamSettings.tlsSettings.alpn = xray.alpn;
        }
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
    } else if (transport === 'xhttp') {
        streamSettings.splithttpSettings = {
            path: xray.xhttpPath || '/',
            host: xray.xhttpHost || '',
            mode: xray.xhttpMode || 'auto',
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
    // Use only userId as email to ensure consistent add/remove via API
    const clients = (users || []).map(u => {
        const client = {
            id: u.xrayUuid,
            email: u.userId,
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
ExecStart=/usr/local/bin/xray run -config /usr/local/etc/xray/config.json
Restart=on-failure
RestartSec=5
LimitNOFILE=1048576

[Install]
WantedBy=multi-user.target
`;
}

// ==================== XRAY CASCADE (Reverse Proxy) ====================

/**
 * Apply reverse-portal configuration to an existing Xray config object.
 * Adds portal entries, bridge-connector inbounds, routing rules, and optional
 * balancer for multiple portals with geo-routing support.
 *
 * @param {Object} config - Parsed Xray config object (mutated in place)
 * @param {Array} portalLinks - CascadeLink documents where this node is portalNode
 * @param {string} clientInboundTag - Tag of the client-facing inbound (e.g. 'vless-in')
 */
function applyReversePortal(config, portalLinks, clientInboundTag) {
    if (!portalLinks || portalLinks.length === 0) return;

    config.reverse = config.reverse || {};
    config.reverse.portals = config.reverse.portals || [];
    config.routing = config.routing || { rules: [] };
    config.routing.rules = config.routing.rules || [];
    config.inbounds = config.inbounds || [];

    const portalTags = [];
    const geoRoutedLinks = [];
    const defaultLinks = [];

    for (const link of portalLinks) {
        const linkIdShort = String(link._id).slice(-8);
        const portalTag = `portal-${linkIdShort}`;
        const connectorTag = `bridge-conn-${linkIdShort}`;

        portalTags.push(portalTag);

        config.reverse.portals.push({
            tag: portalTag,
            domain: link.tunnelDomain || 'reverse.tunnel.internal',
        });

        const protocol = link.tunnelProtocol || 'vless';
        const inbound = {
            tag: connectorTag,
            listen: '0.0.0.0',
            port: link.tunnelPort || 10086,
            protocol,
            settings: {
                clients: [{ id: link.tunnelUuid }],
                decryption: 'none',
            },
            streamSettings: buildCascadeTunnelStreamSettings(link, false),
        };
        config.inbounds.push(inbound);

        // Rule to link connector inbound with portal (required for reverse tunnel handshake)
        config.routing.rules.push({
            type: 'field',
            inboundTag: [connectorTag],
            domain: [`full:${link.tunnelDomain || 'reverse.tunnel.internal'}`],
            outboundTag: portalTag,
        });

        // Separate geo-routed links from default ones
        if (link.geoRouting?.enabled && (link.geoRouting.domains?.length || link.geoRouting.geoip?.length)) {
            geoRoutedLinks.push({ link, portalTag });
        } else {
            defaultLinks.push({ link, portalTag });
        }
    }

    // Add geo-routing rules (specific rules must come before default)
    for (const { link, portalTag } of geoRoutedLinks) {
        const gr = link.geoRouting;
        
        // Domain-based routing rule
        if (gr.domains?.length && clientInboundTag) {
            config.routing.rules.push({
                type: 'field',
                inboundTag: [clientInboundTag],
                domain: gr.domains,
                outboundTag: portalTag,
            });
        }
        
        // GeoIP-based routing rule
        if (gr.geoip?.length && clientInboundTag) {
            config.routing.rules.push({
                type: 'field',
                inboundTag: [clientInboundTag],
                ip: gr.geoip,
                outboundTag: portalTag,
            });
        }
    }

    // Handle default (non-geo-routed) traffic
    if (clientInboundTag) {
        if (defaultLinks.length === 0 && geoRoutedLinks.length > 0) {
            // All links are geo-routed, no default route needed
        } else if (defaultLinks.length === 1) {
            // Single default portal - direct routing
            config.routing.rules.push({
                type: 'field',
                inboundTag: [clientInboundTag],
                outboundTag: defaultLinks[0].portalTag,
            });
        } else if (defaultLinks.length > 1) {
            // Multiple default portals - use balancer with fallback
            const balancerTag = 'portal-balancer';
            const fallbackTag = defaultLinks[0].link.fallbackTag || 'direct';
            config.routing.balancers = config.routing.balancers || [];
            config.routing.balancers.push({
                tag: balancerTag,
                selector: defaultLinks.map(d => d.portalTag),
                strategy: { type: 'leastPing' },
                fallbackTag: fallbackTag,
            });
            config.routing.rules.push({
                type: 'field',
                inboundTag: [clientInboundTag],
                balancerTag: balancerTag,
            });
        } else if (portalTags.length === 1) {
            // Single portal total (could be geo-routed) - use as default fallback
            config.routing.rules.push({
                type: 'field',
                inboundTag: [clientInboundTag],
                outboundTag: portalTags[0],
            });
        }
    }
}

/**
 * Generate a standalone Xray JSON config for a Bridge (exit) node.
 * The Bridge initiates a reverse tunnel to the Portal node and releases traffic
 * to the internet via a freedom outbound.
 *
 * @param {Object} link - CascadeLink document
 * @param {Object} portalNode - HyNode document of the portal node
 * @returns {string} JSON string ready to write to config.json
 */
function generateBridgeConfig(link, portalNode) {
    const tunnelDomain = link.tunnelDomain || 'reverse.tunnel.internal';
    const protocol = link.tunnelProtocol || 'vless';
    const linkIdShort = String(link._id).slice(-8);

    const tunnelOutbound = {
        tag: 'tunnel',
        protocol,
        settings: {
            vnext: [{
                address: portalNode.ip,
                port: link.tunnelPort || 10086,
                users: [{
                    id: link.tunnelUuid,
                    encryption: 'none',
                }],
            }],
        },
        streamSettings: buildCascadeTunnelStreamSettings(link, true),
    };

    // Add MUX if enabled
    const muxConfig = buildMuxConfig(link);
    if (muxConfig) {
        tunnelOutbound.mux = muxConfig;
    }

    const config = {
        log: {
            loglevel: 'warning',
        },
        reverse: {
            bridges: [{
                tag: 'bridge',
                domain: tunnelDomain,
            }],
        },
        outbounds: [
            tunnelOutbound,
            {
                tag: 'freedom',
                protocol: 'freedom',
                settings: { domainStrategy: 'UseIPv4' },
            },
            {
                tag: 'blackhole',
                protocol: 'blackhole',
            },
        ],
        routing: {
            domainStrategy: 'IPIfNonMatch',
            rules: [
                {
                    type: 'field',
                    domain: [`full:${tunnelDomain}`],
                    outboundTag: 'tunnel',
                },
                {
                    type: 'field',
                    inboundTag: ['bridge'],
                    outboundTag: 'freedom',
                },
                {
                    type: 'field',
                    ip: ['geoip:private'],
                    outboundTag: 'blackhole',
                },
            ],
        },
    };

    return JSON.stringify(config, null, 2);
}

/**
 * Generate Xray JSON config for a Relay (intermediate hop) node.
 * The Relay connects upstream to a Portal AND accepts downstream connections from Bridges,
 * forwarding traffic through the chain instead of releasing to internet.
 *
 * @param {Object} upstreamLink - CascadeLink where this node is bridgeNode (connects TO portal)
 * @param {Object} upstreamPortal - HyNode of the upstream portal
 * @param {Array} downstreamLinks - CascadeLinks where this node is portalNode (accepts FROM bridges)
 * @returns {string} JSON string ready to write to config.json
 */
function generateRelayConfig(upstreamLink, upstreamPortal, downstreamLinks) {
    const upDomain = upstreamLink.tunnelDomain || 'reverse.tunnel.internal';
    const upProtocol = upstreamLink.tunnelProtocol || 'vless';
    const upLinkId = String(upstreamLink._id).slice(-8);

    const tunnelUpOutbound = {
        tag: 'tunnel-up',
        protocol: upProtocol,
        settings: {
            vnext: [{
                address: upstreamPortal.ip,
                port: upstreamLink.tunnelPort || 10086,
                users: [{
                    id: upstreamLink.tunnelUuid,
                    encryption: 'none',
                }],
            }],
        },
        streamSettings: buildCascadeTunnelStreamSettings(upstreamLink, true),
    };

    // Add MUX if enabled
    const muxConfig = buildMuxConfig(upstreamLink);
    if (muxConfig) {
        tunnelUpOutbound.mux = muxConfig;
    }

    const config = {
        log: { loglevel: 'warning' },
        reverse: {
            bridges: [{
                tag: 'bridge-up',
                domain: upDomain,
            }],
            portals: [],
        },
        inbounds: [],
        outbounds: [
            tunnelUpOutbound,
            {
                tag: 'freedom',
                protocol: 'freedom',
                settings: { domainStrategy: 'UseIPv4' },
            },
            {
                tag: 'blackhole',
                protocol: 'blackhole',
            },
        ],
        routing: {
            domainStrategy: 'IPIfNonMatch',
            rules: [],
        },
    };

    // FIRST: Add connector rules for each downstream link
    for (const downLink of downstreamLinks) {
        const downLinkId = String(downLink._id).slice(-8);
        const downDomain = downLink.tunnelDomain || 'reverse.tunnel.internal';
        const downProtocol = downLink.tunnelProtocol || 'vless';
        const portalTag = `portal-down-${downLinkId}`;
        const connectorTag = `conn-down-${downLinkId}`;

        config.reverse.portals.push({
            tag: portalTag,
            domain: downDomain,
        });

        config.inbounds.push({
            tag: connectorTag,
            listen: '0.0.0.0',
            port: downLink.tunnelPort || 10086,
            protocol: downProtocol,
            settings: {
                clients: [{ id: downLink.tunnelUuid }],
                decryption: 'none',
            },
            streamSettings: buildCascadeTunnelStreamSettings(downLink, false),
        });

        config.routing.rules.push({
            type: 'field',
            inboundTag: [connectorTag],
            domain: [`full:${downDomain}`],
            outboundTag: portalTag,
        });
    }

    // SECOND: Add tunnel-up rule
    config.routing.rules.push({
        type: 'field',
        domain: [`full:${upDomain}`],
        outboundTag: 'tunnel-up',
    });

    // THIRD: Route traffic from upstream bridge to downstream portal(s)
    if (downstreamLinks.length === 1) {
        const portalTag = `portal-down-${String(downstreamLinks[0]._id).slice(-8)}`;
        config.routing.rules.push({
            type: 'field',
            inboundTag: ['bridge-up'],
            outboundTag: portalTag,
        });
    } else if (downstreamLinks.length > 1) {
        const downstreamTags = downstreamLinks.map(l => `portal-down-${String(l._id).slice(-8)}`);
        const fallbackTag = downstreamLinks[0].fallbackTag || 'freedom';
        config.routing.balancers = config.routing.balancers || [];
        config.routing.balancers.push({
            tag: 'downstream-balancer',
            selector: downstreamTags,
            strategy: { type: 'leastPing' },
            fallbackTag: fallbackTag,
        });
        config.routing.rules.push({
            type: 'field',
            inboundTag: ['bridge-up'],
            balancerTag: 'downstream-balancer',
        });
    }

    // LAST: Blackhole for private IPs
    config.routing.rules.push({
        type: 'field',
        ip: ['geoip:private'],
        outboundTag: 'blackhole',
    });

    return JSON.stringify(config, null, 2);
}

/**
 * Build streamSettings for the cascade tunnel connection between Portal and Bridge.
 * Supports tcp/ws/grpc/xhttp transports and none/tls/reality security.
 *
 * @param {Object} link - CascadeLink document
 * @param {boolean} [isClient=false] - True for client/outbound side, false for server/inbound
 * @returns {Object} streamSettings
 */
function buildCascadeTunnelStreamSettings(link, isClient = false) {
    const transport = link.tunnelTransport || 'tcp';
    const security = link.tunnelSecurity || 'none';

    const stream = {
        network: transport === 'xhttp' ? 'splithttp' : transport,
        security,
    };

    // Security layer
    if (security === 'tls') {
        stream.tlsSettings = isClient
            ? { allowInsecure: true }
            : {
                certificates: [{
                    certificateFile: '/usr/local/etc/xray/cert.pem',
                    keyFile: '/usr/local/etc/xray/key.pem',
                }],
            };
    } else if (security === 'reality') {
        if (isClient) {
            stream.realitySettings = {
                fingerprint: link.realityFingerprint || 'chrome',
                serverName: link.realitySni?.[0] || 'www.google.com',
                publicKey: link.realityPublicKey || '',
                shortId: link.realityShortIds?.[0] || '',
            };
        } else {
            stream.realitySettings = {
                dest: link.realityDest || 'www.google.com:443',
                serverNames: link.realitySni?.length > 0 ? link.realitySni : ['www.google.com'],
                privateKey: link.realityPrivateKey || '',
                shortIds: link.realityShortIds?.length > 0 ? link.realityShortIds : [''],
            };
        }
    }

    // Transport-specific settings
    if (transport === 'tcp') {
        stream.sockopt = {
            tcpFastOpen: link.tcpFastOpen !== false,
            tcpKeepAliveIdle: link.tcpKeepAlive || 100,
            tcpNoDelay: link.tcpNoDelay !== false,
        };
    } else if (transport === 'ws') {
        stream.wsSettings = {
            path: link.wsPath || '/cascade',
            headers: link.wsHost ? { Host: link.wsHost } : {},
        };
    } else if (transport === 'grpc') {
        stream.grpcSettings = {
            serviceName: link.grpcServiceName || 'cascade',
        };
    } else if (transport === 'xhttp') {
        stream.splithttpSettings = {
            path: link.xhttpPath || '/cascade',
            host: link.xhttpHost || '',
            mode: link.xhttpMode || 'auto',
        };
    }

    return stream;
}

/**
 * Build MUX configuration for tunnel outbound
 * @param {Object} link - CascadeLink document
 * @returns {Object|null} mux config or null if disabled
 */
function buildMuxConfig(link) {
    if (!link.muxEnabled) return null;
    
    return {
        enabled: true,
        concurrency: link.muxConcurrency || 8,
        xudpConcurrency: link.muxXudpConcurrency || 16,
        xudpProxyUDP443: link.muxXudpProxyUDP443 || 'reject',
    };
}

/**
 * Generate systemd service unit for a bridge Xray instance.
 * Uses a separate config path to avoid conflicts with a standalone Xray install.
 */
function generateBridgeSystemdService() {
    return `[Unit]
Description=Xray Bridge (Cascade Tunnel)
After=network.target nss-lookup.target

[Service]
User=nobody
CapabilityBoundingSet=CAP_NET_ADMIN CAP_NET_BIND_SERVICE
AmbientCapabilities=CAP_NET_ADMIN CAP_NET_BIND_SERVICE
NoNewPrivileges=true
Type=simple
ExecStart=/usr/local/bin/xray run -config /usr/local/etc/xray-bridge/config.json
Restart=on-failure
RestartSec=5
LimitNOFILE=1048576

[Install]
WantedBy=multi-user.target
`;
}

// ==================== XRAY FORWARD CHAINING ====================

/**
 * Apply forward proxy chain to an existing Xray config.
 * Creates outbounds for each link in the chain using proxySettings.tag mechanism.
 * Traffic flows: client → proxy1 → proxy2 → ... → internet
 *
 * @param {Object} config - Parsed Xray config object (mutated in place)
 * @param {Array} forwardLinks - CascadeLink documents (mode='forward') ordered by chain position
 * @param {string} clientInboundTag - Tag of the client-facing inbound
 */
function applyForwardChain(config, forwardLinks, clientInboundTag) {
    if (!forwardLinks || forwardLinks.length === 0) return;

    config.outbounds = config.outbounds || [];
    config.routing = config.routing || { rules: [] };
    config.routing.rules = config.routing.rules || [];

    const chainOutbounds = [];
    const geoRoutedLinks = [];
    const defaultLinks = [];

    // Create outbounds for each link in the chain
    for (let i = 0; i < forwardLinks.length; i++) {
        const link = forwardLinks[i];
        const bridgeNode = link.bridgeNode;
        const linkIdShort = String(link._id).slice(-8);
        const outboundTag = `chain-${linkIdShort}`;

        const outbound = {
            tag: outboundTag,
            protocol: link.tunnelProtocol || 'vless',
            settings: {
                vnext: [{
                    address: bridgeNode.ip || bridgeNode,
                    port: link.tunnelPort || 443,
                    users: [{
                        id: link.tunnelUuid,
                        encryption: 'none',
                    }],
                }],
            },
            streamSettings: buildCascadeTunnelStreamSettings(link, true),
        };

        // Add MUX if enabled
        const muxConfig = buildMuxConfig(link);
        if (muxConfig) {
            outbound.mux = muxConfig;
        }

        // Chain to next outbound (if not last)
        if (i < forwardLinks.length - 1) {
            const nextLinkId = String(forwardLinks[i + 1]._id).slice(-8);
            outbound.proxySettings = { tag: `chain-${nextLinkId}` };
        }

        chainOutbounds.push(outbound);

        // Separate geo-routed from default
        if (link.geoRouting?.enabled && (link.geoRouting.domains?.length || link.geoRouting.geoip?.length)) {
            geoRoutedLinks.push({ link, outboundTag });
        } else {
            defaultLinks.push({ link, outboundTag });
        }
    }

    // Add chain outbounds to config (in reverse order so last hop is first in array)
    config.outbounds.unshift(...chainOutbounds.reverse());

    // Add geo-routing rules (specific rules first)
    for (const { link, outboundTag } of geoRoutedLinks) {
        const gr = link.geoRouting;
        
        if (gr.domains?.length && clientInboundTag) {
            config.routing.rules.push({
                type: 'field',
                inboundTag: [clientInboundTag],
                domain: gr.domains,
                outboundTag: outboundTag,
            });
        }
        
        if (gr.geoip?.length && clientInboundTag) {
            config.routing.rules.push({
                type: 'field',
                inboundTag: [clientInboundTag],
                ip: gr.geoip,
                outboundTag: outboundTag,
            });
        }
    }

    // Default routing through first hop of chain
    if (clientInboundTag && chainOutbounds.length > 0) {
        if (defaultLinks.length === 1) {
            config.routing.rules.push({
                type: 'field',
                inboundTag: [clientInboundTag],
                outboundTag: defaultLinks[0].outboundTag,
            });
        } else if (defaultLinks.length > 1) {
            // Multiple chains - use balancer
            const balancerTag = 'forward-chain-balancer';
            const fallbackTag = defaultLinks[0].link.fallbackTag || 'direct';
            config.routing.balancers = config.routing.balancers || [];
            config.routing.balancers.push({
                tag: balancerTag,
                selector: defaultLinks.map(d => d.outboundTag),
                strategy: { type: 'leastPing' },
                fallbackTag: fallbackTag,
            });
            config.routing.rules.push({
                type: 'field',
                inboundTag: [clientInboundTag],
                balancerTag: balancerTag,
            });
        } else {
            // All geo-routed, use first chain as fallback
            const firstOutbound = chainOutbounds[chainOutbounds.length - 1];
            config.routing.rules.push({
                type: 'field',
                inboundTag: [clientInboundTag],
                outboundTag: firstOutbound.tag,
            });
        }
    }
}

/**
 * Apply node's custom outbounds (socks5/http proxies) to Xray config.
 * Creates outbound entries and corresponding ACL-like routing rules.
 *
 * @param {Object} config - Parsed Xray config object (mutated in place)
 * @param {Object} node - HyNode with outbounds array
 */
function applyXrayOutbounds(config, node) {
    const customOutbounds = node.outbounds || [];
    if (customOutbounds.length === 0) return;

    config.outbounds = config.outbounds || [];

    for (const ob of customOutbounds) {
        if (ob.type === 'direct') {
            // Direct outbound already exists
            continue;
        }

        const outbound = { tag: ob.name, protocol: ob.type };

        if (ob.type === 'socks5' || ob.type === 'socks') {
            outbound.protocol = 'socks';
            outbound.settings = {
                servers: [{
                    address: ob.addr?.split(':')[0] || '127.0.0.1',
                    port: parseInt(ob.addr?.split(':')[1]) || 1080,
                    users: ob.username ? [{
                        user: ob.username,
                        pass: ob.password || '',
                    }] : undefined,
                }],
            };
        } else if (ob.type === 'http') {
            outbound.settings = {
                servers: [{
                    address: ob.addr?.split(':')[0] || '127.0.0.1',
                    port: parseInt(ob.addr?.split(':')[1]) || 8080,
                    users: ob.username ? [{
                        user: ob.username,
                        pass: ob.password || '',
                    }] : undefined,
                }],
            };
        }

        config.outbounds.push(outbound);
    }

    // Apply ACL rules if specified
    const aclRules = node.aclRules || [];
    if (aclRules.length > 0 && config.routing) {
        config.routing.rules = config.routing.rules || [];
        
        for (const rule of aclRules) {
            // Parse ACL rules like "outbound_name(domain:google.com)" or "reject(geoip:cn)"
            const match = rule.match(/^(\w+)\((.+)\)$/);
            if (!match) continue;

            const [, action, target] = match;
            const routingRule = { type: 'field' };

            // Determine outbound tag
            if (action === 'reject' || action === 'block') {
                routingRule.outboundTag = 'block';
            } else if (action === 'direct') {
                routingRule.outboundTag = 'direct';
            } else {
                routingRule.outboundTag = action;
            }

            // Parse target (domain:xxx, geoip:xxx, ip:xxx)
            if (target.startsWith('domain:')) {
                routingRule.domain = [target.replace('domain:', '')];
            } else if (target.startsWith('geoip:')) {
                routingRule.ip = [target];
            } else if (target.startsWith('geosite:')) {
                routingRule.domain = [target];
            } else if (target.startsWith('ip:')) {
                routingRule.ip = [target.replace('ip:', '')];
            } else {
                routingRule.domain = [target];
            }

            // Insert before the last rule (block private IPs)
            const insertIndex = Math.max(0, config.routing.rules.length - 1);
            config.routing.rules.splice(insertIndex, 0, routingRule);
        }
    }
}

/**
 * Apply cascade configuration to a Portal node's Xray config.
 * Handles both reverse proxy and forward chain modes.
 *
 * @param {Object} config - Parsed Xray config object (mutated in place)
 * @param {Array} cascadeLinks - All CascadeLink documents for this portal
 * @param {string} clientInboundTag - Tag of the client-facing inbound
 */
function applyCascade(config, cascadeLinks, clientInboundTag) {
    if (!cascadeLinks || cascadeLinks.length === 0) return;

    const reverseLinks = cascadeLinks.filter(l => l.mode !== 'forward');
    const forwardLinks = cascadeLinks.filter(l => l.mode === 'forward');

    // Apply reverse proxy configuration
    if (reverseLinks.length > 0) {
        applyReversePortal(config, reverseLinks, clientInboundTag);
    }

    // Apply forward chain configuration
    if (forwardLinks.length > 0) {
        applyForwardChain(config, forwardLinks, clientInboundTag);
    }
}

module.exports = {
    generateNodeConfig,
    generateNodeConfigACME,
    generateSystemdService,
    applyOutboundsAndAcl,
    generateXrayConfig,
    buildXrayStreamSettings,
    generateXraySystemdService,
    applyReversePortal,
    applyForwardChain,
    applyCascade,
    applyXrayOutbounds,
    generateBridgeConfig,
    generateRelayConfig,
    buildCascadeTunnelStreamSettings,
    buildMuxConfig,
    generateBridgeSystemdService,
};
