/**
 * Cascade service — manages Xray reverse-proxy tunnels between nodes.
 *
 * Handles deployment, health checking, and topology retrieval for
 * CascadeLink connections (Portal <-> Bridge pairs).
 */

const net = require('net');
const CascadeLink = require('../models/cascadeLinkModel');
const HyNode = require('../models/hyNodeModel');
const configGenerator = require('./configGenerator');
const NodeSSH = require('./nodeSSH');
const cache = require('./cacheService');
const logger = require('../utils/logger');
const webhook = require('./webhookService');

const TOPOLOGY_CACHE_KEY = 'c3:cascade:topology';
const TOPOLOGY_CACHE_TTL = 15;

/**
 * Safe Redis helpers — cache module exposes .redis but may not be connected.
 */
async function cacheGet(key) {
    try { return cache.redis?.get ? await cache.redis.get(key) : null; } catch { return null; }
}
async function cacheSet(key, value, ttl) {
    try { if (cache.redis?.set) await cache.redis.set(key, value, 'EX', ttl); } catch {}
}
async function cacheDel(key) {
    try { if (cache.redis?.del) await cache.redis.del(key); } catch {}
}

class CascadeService {
    /**
     * Deploy a single cascade link: upload configs to both Portal and Bridge,
     * restart services, and verify tunnel establishment.
     * Supports both 'reverse' and 'forward' modes.
     *
     * @param {Object} link - CascadeLink document (populated with portalNode, bridgeNode)
     * @returns {Promise<{success: boolean, error?: string}>}
     */
    async deployLink(link) {
        const linkId = link._id;
        const mode = link.mode || 'reverse';
        logger.info(`[Cascade] Deploying ${mode} link ${link.name} (${linkId})`);

        await CascadeLink.updateOne({ _id: linkId }, { $set: { status: 'pending', lastError: '' } });

        const portalNode = link.portalNode._id ? link.portalNode : await HyNode.findById(link.portalNode);
        const bridgeNode = link.bridgeNode._id ? link.bridgeNode : await HyNode.findById(link.bridgeNode);

        if (!portalNode || !bridgeNode) {
            const err = 'Portal or Bridge node not found';
            await CascadeLink.updateOne({ _id: linkId }, { $set: { status: 'error', lastError: err } });
            return { success: false, error: err };
        }

        try {
            if (mode === 'forward') {
                // Forward mode: deploy Bridge config (VLESS server) + update Portal config
                
                // Step 1: Deploy forward bridge config (inbound server on Bridge)
                await this._deployForwardBridgeConfig(link, bridgeNode);
                
                // Step 2: Update Portal config with chain outbound
                await this._deployPortalConfig(portalNode);
                
                // Step 3: Open firewall port on Bridge for incoming connections
                await this._openFirewallPort(bridgeNode, link.tunnelPort || 443);

                // Step 4: Wait for Bridge to start and verify connectivity
                await new Promise(r => setTimeout(r, 2000));
                const latencyMs = await this._measureTcpLatency(bridgeNode.ip, link.tunnelPort || 443);
                const healthy = latencyMs !== null;

                const newStatus = healthy ? 'online' : 'deployed';
                await CascadeLink.updateOne({ _id: linkId }, {
                    $set: {
                        status:          newStatus,
                        lastError:       healthy ? '' : 'Cannot connect to Bridge',
                        lastHealthCheck: new Date(),
                        latencyMs:       latencyMs,
                    },
                });

                logger.info(`[Cascade] Forward link ${link.name} deployed, status=${newStatus}`);
            } else {
                // Reverse mode: deploy both Portal and Bridge configs
                await this._deployPortalConfig(portalNode);
                await this._deployBridgeConfig(link, bridgeNode, portalNode);
                await this._openFirewallPort(portalNode, link.tunnelPort || 10086);

                // Verify tunnel (give Bridge time to connect)
                const tunnelPort = link.tunnelPort || 10086;
                await new Promise(r => setTimeout(r, 3000));
                
                const [healthy, latencyMs] = await Promise.all([
                    this._checkTunnelHealth(link, portalNode, bridgeNode),
                    this._measureTcpLatency(portalNode.ip, tunnelPort),
                ]);

                const newStatus = healthy ? 'online' : 'deployed';
                await CascadeLink.updateOne({ _id: linkId }, {
                    $set: {
                        status:          newStatus,
                        lastError:       '',
                        lastHealthCheck: new Date(),
                        latencyMs:       latencyMs,
                    },
                });

                logger.info(`[Cascade] Reverse link ${link.name} deployed, status=${newStatus}`);
            }

            await this._updateNodeRoles();
            await this._invalidateTopologyCache();

            return { success: true };
        } catch (error) {
            logger.error(`[Cascade] Deploy failed for ${link.name}: ${error.message}`);
            await CascadeLink.updateOne({ _id: linkId }, {
                $set: { status: 'error', lastError: error.message },
            });
            return { success: false, error: error.message };
        }
    }

    /**
     * Undeploy a cascade link: regenerate Portal config without this link's
     * reverse settings and stop the Bridge Xray service.
     */
    async undeployLink(link) {
        const portalNode = await HyNode.findById(link.portalNode);
        const bridgeNode = await HyNode.findById(link.bridgeNode);

        if (portalNode) {
            try {
                await this._deployPortalConfig(portalNode);
            } catch (err) {
                logger.warn(`[Cascade] Portal redeploy on undeploy: ${err.message}`);
            }
        }

        if (bridgeNode && (bridgeNode.ssh?.password || bridgeNode.ssh?.privateKey)) {
            const ssh = new NodeSSH(bridgeNode);
            try {
                await ssh.connect();
                await ssh.exec('systemctl stop xray-bridge 2>/dev/null; systemctl disable xray-bridge 2>/dev/null');
                logger.info(`[Cascade] Bridge service stopped on ${bridgeNode.name}`);
            } catch (err) {
                logger.warn(`[Cascade] Bridge stop on undeploy: ${err.message}`);
            } finally {
                ssh.disconnect();
            }
        }

        await CascadeLink.updateOne({ _id: link._id }, { $set: { status: 'pending', lastError: '' } });
        await this._updateNodeRoles();
        await this._invalidateTopologyCache();
    }

    /**
     * Redeploy all cascade links associated with a given node.
     * Called when a node's configuration changes.
     */
    async redeployAllLinksForNode(nodeId) {
        const links = await CascadeLink.find({
            $or: [{ portalNode: nodeId }, { bridgeNode: nodeId }],
            active: true,
            status: { $in: ['deployed', 'online', 'offline'] },
        }).populate('portalNode bridgeNode');

        for (const link of links) {
            await this.deployLink(link).catch(err => {
                logger.error(`[Cascade] Redeploy link ${link.name}: ${err.message}`);
            });
        }
    }

    /**
     * Deploy an entire cascade chain in the correct order.
     * Finds all connected links starting from any node in the chain,
     * builds topological order (Portal → Relay → Bridge), and deploys
     * configs + restarts services with proper delays.
     *
     * @param {string} startNodeId - Any node ID in the chain
     * @returns {Promise<{success: boolean, deployed: number, errors: string[]}>}
     */
    async deployChain(startNodeId) {
        logger.info(`[Cascade] Starting chain deployment from node ${startNodeId}`);

        // 1. Find all links connected to this chain
        const { orderedNodes, orderedLinks } = await this._buildChainOrder(startNodeId);

        if (orderedLinks.length === 0) {
            return { success: true, deployed: 0, errors: [], message: 'No active links found' };
        }

        logger.info(`[Cascade] Chain has ${orderedNodes.length} nodes, ${orderedLinks.length} links`);

        const errors = [];
        let deployed = 0;

        // 2. Deploy configs in order: head (pure Portal) → middle (Relays) → tail (pure Bridge)
        for (let i = 0; i < orderedNodes.length; i++) {
            const node = orderedNodes[i];
            const nodeLinks = orderedLinks.filter(
                l => String(l.portalNode._id || l.portalNode) === String(node._id) ||
                     String(l.bridgeNode._id || l.bridgeNode) === String(node._id)
            );

            try {
                await this._deployNodeInChain(node, nodeLinks, orderedLinks);
                deployed++;
                logger.info(`[Cascade] Deployed node ${i + 1}/${orderedNodes.length}: ${node.name}`);

                // Wait between nodes for proper service registration
                if (i < orderedNodes.length - 1) {
                    await new Promise(r => setTimeout(r, 2000));
                }
            } catch (err) {
                errors.push(`${node.name}: ${err.message}`);
                logger.error(`[Cascade] Failed to deploy ${node.name}: ${err.message}`);
            }
        }

        // 3. Update link statuses after deployment
        await new Promise(r => setTimeout(r, 3000));
        for (const link of orderedLinks) {
            await this.healthCheckLink(link).catch(() => {});
        }

        await this._updateNodeRoles();
        await this._invalidateTopologyCache();

        const success = errors.length === 0;
        logger.info(`[Cascade] Chain deployment complete: ${deployed} nodes, ${errors.length} errors`);

        return { success, deployed, errors };
    }

    /**
     * Build topological order of nodes in the chain.
     * Returns nodes ordered from head (pure Portal) to tail (pure Bridge).
     */
    async _buildChainOrder(startNodeId) {
        // Get all active links
        const allLinks = await CascadeLink.find({ active: true })
            .populate('portalNode bridgeNode')
            .lean();

        if (allLinks.length === 0) {
            return { orderedNodes: [], orderedLinks: [] };
        }

        // Build adjacency: nodeId -> { asPortal: [links], asBridge: [links] }
        const nodeMap = new Map();
        const linkSet = new Set();

        const addNode = (node) => {
            const id = String(node._id || node);
            if (!nodeMap.has(id)) {
                nodeMap.set(id, { node, asPortal: [], asBridge: [] });
            }
            return nodeMap.get(id);
        };

        for (const link of allLinks) {
            const portalId = String(link.portalNode._id || link.portalNode);
            const bridgeId = String(link.bridgeNode._id || link.bridgeNode);

            addNode(link.portalNode).asPortal.push(link);
            addNode(link.bridgeNode).asBridge.push(link);
        }

        // BFS to find all connected nodes starting from startNodeId
        const visited = new Set();
        const queue = [String(startNodeId)];
        const connectedLinks = [];

        while (queue.length > 0) {
            const nodeId = queue.shift();
            if (visited.has(nodeId)) continue;
            visited.add(nodeId);

            const entry = nodeMap.get(nodeId);
            if (!entry) continue;

            for (const link of [...entry.asPortal, ...entry.asBridge]) {
                const linkId = String(link._id);
                if (!linkSet.has(linkId)) {
                    linkSet.add(linkId);
                    connectedLinks.push(link);
                }

                const portalId = String(link.portalNode._id || link.portalNode);
                const bridgeId = String(link.bridgeNode._id || link.bridgeNode);

                if (!visited.has(portalId)) queue.push(portalId);
                if (!visited.has(bridgeId)) queue.push(bridgeId);
            }
        }

        // Find head nodes (portals that are not bridges in this chain)
        const bridgeIds = new Set(connectedLinks.map(l => String(l.bridgeNode._id || l.bridgeNode)));
        const portalIds = new Set(connectedLinks.map(l => String(l.portalNode._id || l.portalNode)));

        const headIds = [...portalIds].filter(id => !bridgeIds.has(id));

        // Topological sort from heads
        const orderedNodes = [];
        const orderedNodeIds = new Set();
        const toVisit = headIds.map(id => nodeMap.get(id)?.node).filter(Boolean);

        while (toVisit.length > 0) {
            const node = toVisit.shift();
            const nodeId = String(node._id);

            if (orderedNodeIds.has(nodeId)) continue;
            orderedNodeIds.add(nodeId);
            orderedNodes.push(node);

            // Add downstream nodes (where this node is portal)
            const entry = nodeMap.get(nodeId);
            if (entry) {
                for (const link of entry.asPortal) {
                    const bridgeNode = link.bridgeNode;
                    const bridgeId = String(bridgeNode._id || bridgeNode);
                    if (!orderedNodeIds.has(bridgeId)) {
                        toVisit.push(bridgeNode);
                    }
                }
            }
        }

        return { orderedNodes, orderedLinks: connectedLinks };
    }

    /**
     * Deploy a single node within a chain context.
     * Determines if node is Portal, Relay, or Bridge and applies appropriate config.
     */
    async _deployNodeInChain(node, nodeLinks, allChainLinks) {
        const nodeId = String(node._id);

        // Find links where this node is portal (downstream) and bridge (upstream)
        const asPortalLinks = allChainLinks.filter(l => String(l.portalNode._id || l.portalNode) === nodeId);
        const asBridgeLinks = allChainLinks.filter(l => String(l.bridgeNode._id || l.bridgeNode) === nodeId);

        const isPortal = asPortalLinks.length > 0;
        const isBridge = asBridgeLinks.length > 0;

        if (isPortal && !isBridge) {
            // Pure Portal (head of chain)
            await this._deployPortalConfig(node);
            for (const link of asPortalLinks) {
                await this._openFirewallPort(node, link.tunnelPort || 10086);
            }
        } else if (isBridge && isPortal) {
            // Relay (middle of chain)
            const upstreamLink = asBridgeLinks[0];
            const upstreamPortal = await HyNode.findById(upstreamLink.portalNode);
            await this._deployRelayNode(node, upstreamLink, upstreamPortal, asPortalLinks);
            for (const link of asPortalLinks) {
                await this._openFirewallPort(node, link.tunnelPort || 10086);
            }
        } else if (isBridge && !isPortal) {
            // Pure Bridge (tail of chain)
            const upstreamLink = asBridgeLinks[0];
            const upstreamPortal = await HyNode.findById(upstreamLink.portalNode);
            await this._deployPureBridge(node, upstreamLink, upstreamPortal);
        }
    }

    /**
     * Deploy Relay node config (middle of chain).
     */
    async _deployRelayNode(node, upstreamLink, upstreamPortal, downstreamLinks) {
        if (!node.ssh?.password && !node.ssh?.privateKey) {
            throw new Error(`Relay node ${node.name} has no SSH credentials`);
        }

        const relayConfig = configGenerator.generateRelayConfig(upstreamLink, upstreamPortal, downstreamLinks);
        const serviceUnit = configGenerator.generateBridgeSystemdService();

        const ssh = new NodeSSH(node);
        try {
            await ssh.connect();

            // Ensure Xray is installed
            const xrayCheck = await ssh.exec('command -v xray');
            if (!xrayCheck.stdout || !xrayCheck.stdout.trim()) {
                logger.info(`[Cascade] Installing Xray on relay ${node.name}`);
                await ssh.exec(
                    'curl -L https://github.com/XTLS/Xray-install/raw/main/install-release.sh -o /tmp/xray-install.sh ' +
                    '&& chmod +x /tmp/xray-install.sh && bash /tmp/xray-install.sh install 2>&1 && rm -f /tmp/xray-install.sh'
                );
            }

            await ssh.exec('mkdir -p /usr/local/etc/xray-bridge');
            await ssh.uploadContent(relayConfig, '/usr/local/etc/xray-bridge/config.json');
            await ssh.uploadContent(serviceUnit, '/etc/systemd/system/xray-bridge.service');
            await ssh.exec('systemctl daemon-reload && systemctl enable xray-bridge && systemctl restart xray-bridge');

            logger.info(`[Cascade] Relay config deployed to ${node.name}`);
        } finally {
            ssh.disconnect();
        }
    }

    /**
     * Deploy pure Bridge node config (tail of chain) for REVERSE mode.
     */
    async _deployPureBridge(node, upstreamLink, upstreamPortal) {
        if (!node.ssh?.password && !node.ssh?.privateKey) {
            throw new Error(`Bridge node ${node.name} has no SSH credentials`);
        }

        const bridgeConfig = configGenerator.generateBridgeConfig(upstreamLink, upstreamPortal);
        const serviceUnit = configGenerator.generateBridgeSystemdService();

        const ssh = new NodeSSH(node);
        try {
            await ssh.connect();

            // Ensure Xray is installed
            const xrayCheck = await ssh.exec('command -v xray');
            if (!xrayCheck.stdout || !xrayCheck.stdout.trim()) {
                logger.info(`[Cascade] Installing Xray on bridge ${node.name}`);
                await ssh.exec(
                    'curl -L https://github.com/XTLS/Xray-install/raw/main/install-release.sh -o /tmp/xray-install.sh ' +
                    '&& chmod +x /tmp/xray-install.sh && bash /tmp/xray-install.sh install 2>&1 && rm -f /tmp/xray-install.sh'
                );
            }

            await ssh.exec('mkdir -p /usr/local/etc/xray-bridge');
            await ssh.uploadContent(bridgeConfig, '/usr/local/etc/xray-bridge/config.json');
            await ssh.uploadContent(serviceUnit, '/etc/systemd/system/xray-bridge.service');
            await ssh.exec('systemctl daemon-reload && systemctl enable xray-bridge && systemctl restart xray-bridge');

            logger.info(`[Cascade] Bridge config deployed to ${node.name}`);
        } finally {
            ssh.disconnect();
        }
    }

    /**
     * Deploy Forward Bridge config (exit node for FORWARD mode).
     * Creates a VLESS inbound server that accepts connections from Portal.
     */
    async _deployForwardBridgeConfig(link, bridgeNode) {
        if (!bridgeNode.ssh?.password && !bridgeNode.ssh?.privateKey) {
            throw new Error(`Forward Bridge node ${bridgeNode.name} has no SSH credentials`);
        }

        const bridgeConfig = configGenerator.generateForwardBridgeConfig(link);
        const serviceUnit = configGenerator.generateBridgeSystemdService();

        const ssh = new NodeSSH(bridgeNode);
        try {
            await ssh.connect();

            // Ensure Xray is installed
            const xrayCheck = await ssh.exec('command -v xray');
            if (!xrayCheck.stdout || !xrayCheck.stdout.trim()) {
                logger.info(`[Cascade] Installing Xray on forward bridge ${bridgeNode.name}`);
                await ssh.exec(
                    'curl -L https://github.com/XTLS/Xray-install/raw/main/install-release.sh -o /tmp/xray-install.sh ' +
                    '&& chmod +x /tmp/xray-install.sh && bash /tmp/xray-install.sh install 2>&1 && rm -f /tmp/xray-install.sh'
                );
            }

            await ssh.exec('mkdir -p /usr/local/etc/xray-bridge');
            await ssh.uploadContent(bridgeConfig, '/usr/local/etc/xray-bridge/config.json');
            await ssh.uploadContent(serviceUnit, '/etc/systemd/system/xray-bridge.service');
            await ssh.exec('systemctl daemon-reload && systemctl enable xray-bridge && systemctl restart xray-bridge');

            // Verify the service started
            const statusResult = await ssh.exec('sleep 1 && systemctl is-active xray-bridge');
            const isActive = (statusResult.stdout || '').trim() === 'active';

            if (!isActive) {
                const logs = await ssh.exec('journalctl -u xray-bridge --no-pager -n 20');
                throw new Error(`Forward Bridge service not active. Logs: ${(logs.stdout || logs.stderr || '').slice(0, 500)}`);
            }

            logger.info(`[Cascade] Forward Bridge config deployed to ${bridgeNode.name}`);
        } finally {
            ssh.disconnect();
        }
    }

    /**
     * Health-check a single cascade link.
     * For reverse mode: verifies ESTABLISHED connections on Portal's tunnel port.
     * For forward mode: verifies TCP connectivity to Bridge.
     */
    async healthCheckLink(link) {
        const mode = link.mode || 'reverse';
        const portalNode = await HyNode.findById(link.portalNode);
        const bridgeNode = await HyNode.findById(link.bridgeNode);
        
        if (!portalNode) return false;

        try {
            let healthy, latencyMs;

            if (mode === 'forward') {
                // Forward mode: check connectivity to bridge
                const bridgePort = link.tunnelPort || 443;
                latencyMs = await this._measureTcpLatency(bridgeNode?.ip || link.bridgeNode, bridgePort);
                healthy = latencyMs !== null;
            } else {
                // Reverse mode: check tunnel connections and health
                const tunnelPort = link.tunnelPort || 10086;
                [healthy, latencyMs] = await Promise.all([
                    this._checkTunnelHealth(link, portalNode, bridgeNode),
                    this._measureTcpLatency(portalNode.ip, tunnelPort),
                ]);
            }

            const prevStatus = link.status;
            const newStatus  = healthy ? 'online' : 'offline';

            await CascadeLink.updateOne({ _id: link._id }, {
                $set: {
                    status:          newStatus,
                    lastHealthCheck: new Date(),
                    lastError:       healthy ? '' : `${mode} tunnel not responding`,
                    latencyMs:       latencyMs,
                },
            });

            if (prevStatus !== newStatus) {
                const event = healthy ? 'cascade.online' : 'cascade.offline';
                webhook.emit(event, { linkId: link._id, name: link.name, mode });
                logger.info(`[Cascade] Link ${link.name} (${mode}): ${prevStatus} -> ${newStatus}, latency=${latencyMs}ms`);
            }

            return healthy;
        } catch (error) {
            await CascadeLink.updateOne({ _id: link._id }, {
                $set: { status: 'error', lastError: error.message, lastHealthCheck: new Date() },
            });
            return false;
        }
    }

    /**
     * Health-check all active, deployed cascade links.
     * Called periodically by cron.
     */
    async healthCheckAll() {
        const links = await CascadeLink.find({
            active: true,
            status: { $in: ['deployed', 'online', 'offline'] },
        });

        if (links.length === 0) return;

        const CONCURRENCY = 5;
        for (let i = 0; i < links.length; i += CONCURRENCY) {
            const batch = links.slice(i, i + CONCURRENCY);
            await Promise.allSettled(batch.map(l => this.healthCheckLink(l)));
        }

        await this._invalidateTopologyCache();
    }

    /**
     * Build the full network topology graph for the visual map.
     * Returns nodes and edges formatted for cytoscape.js consumption.
     * Cached in Redis for performance.
     *
     * @returns {Promise<{nodes: Array, edges: Array}>}
     */
    async getTopology() {
        const cached = await cacheGet(TOPOLOGY_CACHE_KEY);
        if (cached) {
            try { return JSON.parse(cached); } catch (_) {}
        }

        const [allNodes, allLinks] = await Promise.all([
            HyNode.find({ active: true })
                .select('name ip domain flag type status onlineUsers cascadeRole mapPosition country port')
                .lean(),
            CascadeLink.find({ active: true })
                .populate('portalNode', 'name ip')
                .populate('bridgeNode', 'name ip')
                .lean(),
        ]);

        const nodes = allNodes.map(n => ({
            data: {
                id: String(n._id),
                label: n.name,
                ip: n.ip,
                domain: n.domain || '',
                flag: n.flag || '',
                type: n.type,
                status: n.status,
                onlineUsers: n.onlineUsers || 0,
                cascadeRole: n.cascadeRole || 'standalone',
                country: n.country || '',
                port: n.port,
            },
            position: (n.mapPosition?.x != null && n.mapPosition?.y != null)
                ? { x: n.mapPosition.x, y: n.mapPosition.y }
                : undefined,
        }));

        const edges = allLinks.map(l => ({
            data: {
                id: `link-${l._id}`,
                linkId: String(l._id),
                source: String(l.portalNode?._id || l.portalNode),
                target: String(l.bridgeNode?._id || l.bridgeNode),
                label: l.name,
                status: l.status,
                mode: l.mode || 'reverse',
                tunnelPort: l.tunnelPort,
                latencyMs: l.latencyMs,
                tunnelProtocol: l.tunnelProtocol,
                tunnelTransport: l.tunnelTransport,
                tunnelSecurity: l.tunnelSecurity,
                muxEnabled: l.muxEnabled || false,
                geoRoutingEnabled: l.geoRouting?.enabled || false,
            },
        }));

        // Add virtual "Internet" node and edges from exit/standalone nodes
        const exitNodes = allNodes.filter(n =>
            n.cascadeRole === 'bridge' || n.cascadeRole === 'standalone' || !n.cascadeRole
        );

        if (exitNodes.length > 0) {
            nodes.push({
                data: {
                    id: 'internet',
                    label: 'Internet',
                    ip: '',
                    domain: '',
                    flag: '🌐',
                    type: 'internet',
                    status: 'online',
                    onlineUsers: 0,
                    cascadeRole: 'internet',
                    country: '',
                    port: null,
                },
                position: undefined,
            });

            for (const exitNode of exitNodes) {
                edges.push({
                    data: {
                        id: `internet-${exitNode._id}`,
                        linkId: null,
                        source: String(exitNode._id),
                        target: 'internet',
                        label: '',
                        status: exitNode.status === 'online' ? 'online' : 'offline',
                        tunnelPort: null,
                        latencyMs: null,
                        tunnelProtocol: null,
                        tunnelTransport: null,
                        isInternetEdge: true,
                    },
                });
            }
        }

        const topology = { nodes, edges };
        await cacheSet(TOPOLOGY_CACHE_KEY, JSON.stringify(topology), TOPOLOGY_CACHE_TTL);
        return topology;
    }

    /**
     * Save node positions from the visual map editor.
     * @param {Array<{id: string, x: number, y: number}>} positions
     */
    async savePositions(positions) {
        if (!Array.isArray(positions) || positions.length === 0) return;

        const bulkOps = positions
            .filter(p => p.id && typeof p.x === 'number' && typeof p.y === 'number')
            .map(p => ({
                updateOne: {
                    filter: { _id: p.id },
                    update: { $set: { 'mapPosition.x': p.x, 'mapPosition.y': p.y } },
                },
            }));

        if (bulkOps.length > 0) {
            await HyNode.bulkWrite(bulkOps, { ordered: false });
            await this._invalidateTopologyCache();
        }
    }

    // ==================== INTERNAL HELPERS ====================

    /**
     * Regenerate and upload the Portal node's full Xray config, including
     * all cascade settings (reverse proxy and forward chains) from active links.
     */
    async _deployPortalConfig(portalNode) {
        const syncService = require('./syncService');
        const users = await syncService._getUsersForNode(portalNode);

        const configStr = configGenerator.generateXrayConfig(portalNode, users);
        const config = JSON.parse(configStr);

        // Get all cascade links where this node is the portal
        const portalLinks = await CascadeLink.find({
            portalNode: portalNode._id,
            active: true,
        }).populate('bridgeNode', 'ip');

        const inboundTag = portalNode.xray?.inboundTag || 'vless-in';
        
        // Apply cascade configuration (handles both reverse and forward modes)
        configGenerator.applyCascade(config, portalLinks, inboundTag);

        // Apply custom outbounds and ACL rules
        configGenerator.applyXrayOutbounds(config, portalNode);

        const finalConfig = JSON.stringify(config, null, 2);

        if (portalNode.ssh?.password || portalNode.ssh?.privateKey) {
            const ssh = new NodeSSH(portalNode);
            try {
                await ssh.connect();
                // Xray nodes use different config path than Hysteria
                const configPath = portalNode.type === 'xray'
                    ? '/usr/local/etc/xray/config.json'
                    : (portalNode.paths?.config || '/etc/hysteria/config.yaml');
                await ssh.uploadContent(finalConfig, configPath);
                logger.info(`[Cascade] Portal config uploaded to ${portalNode.name} at ${configPath}`);
            } finally {
                ssh.disconnect();
            }
        }

        const hasAgent = !!(portalNode.xray?.agentToken);
        if (hasAgent) {
            try {
                await syncService._agentRequest(portalNode, 'POST', '/restart');
                logger.info(`[Cascade] Portal ${portalNode.name} restarted via agent`);
            } catch (err) {
                logger.warn(`[Cascade] Portal agent restart: ${err.message}`);
                if (portalNode.ssh?.password || portalNode.ssh?.privateKey) {
                    const ssh = new NodeSSH(portalNode);
                    try {
                        await ssh.connect();
                        await ssh.exec('systemctl restart xray');
                    } finally { ssh.disconnect(); }
                }
            }
        } else if (portalNode.ssh?.password || portalNode.ssh?.privateKey) {
            const ssh = new NodeSSH(portalNode);
            try {
                await ssh.connect();
                await ssh.exec('systemctl restart xray');
            } finally { ssh.disconnect(); }
        }
    }

    /**
     * Generate and upload the Bridge/Relay config, create systemd service, and start it.
     * Detects if bridgeNode is also a portal (relay) and generates appropriate config.
     */
    async _deployBridgeConfig(link, bridgeNode, portalNode) {
        if (!bridgeNode.ssh?.password && !bridgeNode.ssh?.privateKey) {
            throw new Error(`Bridge node ${bridgeNode.name} has no SSH credentials`);
        }

        // Check if this bridgeNode is also a portal for other links (i.e., it's a relay)
        const downstreamLinks = await CascadeLink.find({
            portalNode: bridgeNode._id,
            active: true,
        });
        const isRelay = downstreamLinks.length > 0;

        let bridgeConfig;
        if (isRelay) {
            logger.info(`[Cascade] Node ${bridgeNode.name} is a RELAY (${downstreamLinks.length} downstream link(s))`);
            bridgeConfig = configGenerator.generateRelayConfig(link, portalNode, downstreamLinks);
        } else {
            bridgeConfig = configGenerator.generateBridgeConfig(link, portalNode);
        }

        const serviceUnit = configGenerator.generateBridgeSystemdService();

        const ssh = new NodeSSH(bridgeNode);
        try {
            await ssh.connect();

            // Ensure Xray is installed
            const xrayCheck = await ssh.exec('command -v xray');
            if (!xrayCheck.stdout || !xrayCheck.stdout.trim()) {
                logger.info(`[Cascade] Installing Xray on bridge ${bridgeNode.name}`);
                await ssh.exec(
                    'curl -L https://github.com/XTLS/Xray-install/raw/main/install-release.sh -o /tmp/xray-install.sh ' +
                    '&& chmod +x /tmp/xray-install.sh && bash /tmp/xray-install.sh install 2>&1 && rm -f /tmp/xray-install.sh'
                );
            }

            await ssh.exec('mkdir -p /usr/local/etc/xray-bridge');
            await ssh.uploadContent(bridgeConfig, '/usr/local/etc/xray-bridge/config.json');
            await ssh.uploadContent(serviceUnit, '/etc/systemd/system/xray-bridge.service');

            await ssh.exec('systemctl daemon-reload && systemctl enable xray-bridge && systemctl restart xray-bridge');

            // Verify the service started
            const statusResult = await ssh.exec('sleep 1 && systemctl is-active xray-bridge');
            const isActive = (statusResult.stdout || '').trim() === 'active';

            if (!isActive) {
                const logs = await ssh.exec('journalctl -u xray-bridge --no-pager -n 20');
                throw new Error(`Bridge service not active. Logs: ${(logs.stdout || logs.stderr || '').slice(0, 500)}`);
            }

            logger.info(`[Cascade] ${isRelay ? 'Relay' : 'Bridge'} config deployed to ${bridgeNode.name}`);
        } finally {
            ssh.disconnect();
        }
    }

    /**
     * Open the tunnel port in the firewall on the Portal node.
     */
    async _openFirewallPort(node, port) {
        if (!node.ssh?.password && !node.ssh?.privateKey) return;

        const ssh = new NodeSSH(node);
        try {
            await ssh.connect();
            await ssh.exec(`
                if command -v ufw &>/dev/null; then
                    ufw allow ${port}/tcp 2>/dev/null
                elif command -v firewall-cmd &>/dev/null; then
                    firewall-cmd --permanent --add-port=${port}/tcp 2>/dev/null
                    firewall-cmd --reload 2>/dev/null
                fi
            `);
        } catch (err) {
            logger.warn(`[Cascade] Firewall open port ${port}: ${err.message}`);
        } finally {
            ssh.disconnect();
        }
    }

    /**
     * Check if there are ESTABLISHED connections on a given port (tunnel alive).
     */
    async _checkTunnel(node, port) {
        if (!node.ssh?.password && !node.ssh?.privateKey) return false;

        const ssh = new NodeSSH(node);
        try {
            await ssh.connect();
            // ss -tnH: -t=tcp, -n=numeric, -H=no header; count lines = count of ESTABLISHED connections
            const result = await ssh.exec(`ss -tnH state established '( sport = :${port} )' | wc -l`);
            const count = parseInt((result.stdout || '0').trim(), 10);
            return count > 0;
        } catch {
            return false;
        } finally {
            ssh.disconnect();
        }
    }

    /**
     * Enhanced tunnel health check: verifies both ESTABLISHED connections
     * and actual data flow through the tunnel via HTTP probe.
     *
     * @param {Object} link - CascadeLink document
     * @param {Object} portalNode - Portal HyNode
     * @param {Object} bridgeNode - Bridge HyNode  
     * @returns {Promise<boolean>} true if tunnel is healthy
     */
    async _checkTunnelHealth(link, portalNode, bridgeNode) {
        const tunnelPort = link.tunnelPort || 10086;

        // Step 1: Check ESTABLISHED connections on portal
        const hasConnections = await this._checkTunnel(portalNode, tunnelPort);
        if (!hasConnections) {
            logger.debug(`[Cascade] No ESTABLISHED connections on ${portalNode.name}:${tunnelPort}`);
            return false;
        }

        // Step 2: Try to ping through tunnel (if bridge has SSH access)
        if (bridgeNode.ssh?.password || bridgeNode.ssh?.privateKey) {
            try {
                const ssh = new NodeSSH(bridgeNode);
                await ssh.connect();
                
                // Check if xray-bridge service is running and healthy
                const statusResult = await ssh.exec('systemctl is-active xray-bridge 2>/dev/null || echo inactive');
                const isActive = (statusResult.stdout || '').trim() === 'active';
                
                if (!isActive) {
                    logger.debug(`[Cascade] Bridge service not active on ${bridgeNode.name}`);
                    ssh.disconnect();
                    return false;
                }

                // Try to resolve a domain through the tunnel to verify end-to-end connectivity
                const pingResult = await ssh.exec(
                    'timeout 5 curl -s -o /dev/null -w "%{http_code}" https://www.google.com 2>/dev/null || echo 000'
                );
                const httpCode = (pingResult.stdout || '000').trim();
                
                ssh.disconnect();

                if (httpCode === '200' || httpCode === '301' || httpCode === '302') {
                    logger.debug(`[Cascade] Tunnel ping success through ${bridgeNode.name}`);
                    return true;
                } else {
                    logger.debug(`[Cascade] Tunnel ping failed on ${bridgeNode.name}: HTTP ${httpCode}`);
                }
            } catch (err) {
                logger.debug(`[Cascade] Tunnel ping error: ${err.message}`);
            }
        }

        // Fallback: if we have ESTABLISHED connections, consider it healthy
        return hasConnections;
    }

    /**
     * Recalculate cascadeRole for all nodes based on their active links.
     */
    async _updateNodeRoles() {
        const links = await CascadeLink.find({ active: true }).lean();

        const portalSet = new Set(links.map(l => String(l.portalNode)));
        const bridgeSet = new Set(links.map(l => String(l.bridgeNode)));

        const allNodes = await HyNode.find({ active: true }).select('_id cascadeRole').lean();

        const bulkOps = [];
        for (const node of allNodes) {
            const id = String(node._id);
            const isPortal = portalSet.has(id);
            const isBridge = bridgeSet.has(id);

            let role = 'standalone';
            if (isPortal && isBridge) role = 'relay';
            else if (isPortal) role = 'portal';
            else if (isBridge) role = 'bridge';

            if (node.cascadeRole !== role) {
                bulkOps.push({
                    updateOne: {
                        filter: { _id: node._id },
                        update: { $set: { cascadeRole: role } },
                    },
                });
            }
        }

        if (bulkOps.length > 0) {
            await HyNode.bulkWrite(bulkOps, { ordered: false });
        }
    }

    async _invalidateTopologyCache() {
        await cacheDel(TOPOLOGY_CACHE_KEY);
    }

    /**
     * Measure TCP handshake latency to host:port.
     * Returns latency in ms, or null on timeout/error.
     * @param {string} host
     * @param {number} port
     * @param {number} [timeoutMs=3000]
     * @returns {Promise<number|null>}
     */
    async _measureTcpLatency(host, port, timeoutMs = 3000) {
        return new Promise((resolve) => {
            const start  = Date.now();
            const socket = new net.Socket();
            socket.setTimeout(timeoutMs);

            socket.connect(port, host, function () {
                const latency = Date.now() - start;
                socket.destroy();
                resolve(latency);
            });

            socket.on('error', function () {
                socket.destroy();
                resolve(null);
            });

            socket.on('timeout', function () {
                socket.destroy();
                resolve(null);
            });
        });
    }
}

module.exports = new CascadeService();
