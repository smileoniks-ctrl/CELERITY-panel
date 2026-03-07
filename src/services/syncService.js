/**
 * Hysteria + Xray nodes sync service
 *
 * Hysteria: HTTP auth callback — no user sync needed, auth happens in realtime.
 * Xray: users embedded in config + managed via SSH + xray api gRPC commands.
 *
 * This service handles:
 * - Node config updates (Hysteria YAML / Xray JSON)
 * - Traffic stats collection
 * - Node health checks
 * - Xray user add/remove via gRPC API over SSH
 */

const HyUser = require('../models/hyUserModel');
const HyNode = require('../models/hyNodeModel');
const Settings = require('../models/settingsModel');
const NodeSSH = require('./nodeSSH');
const configGenerator = require('./configGenerator');
const cache = require('./cacheService');
const logger = require('../utils/logger');
const axios = require('axios');
const config = require('../../config');
const webhook = require('./webhookService');

class SyncService {
    constructor() {
        this.isSyncing = false;
        this.lastSyncTime = null;
        // Track which users have already received a traffic/expiry webhook in this
        // process lifetime to avoid spamming the same event every stats cycle.
        this._notifiedTraffic = new Set();
        this._notifiedExpired = new Set();
    }

    /**
     * Get HTTP auth URL
     */
    getAuthUrl() {
        return `${config.BASE_URL}/api/auth`;
    }

    // ==================== XRAY METHODS ====================

    /**
     * Get all enabled users for a given node (by groups or explicit node list)
     */
    async _getUsersForNode(node) {
        const nodeId = node._id.toString();
        // Users with explicit node assignment
        const byNodes = await HyUser.find({ nodes: node._id, enabled: true }).lean();
        // Users linked via groups
        const nodeGroupIds = (node.groups || []).map(g => g._id?.toString() || g.toString());
        let byGroups = [];
        if (nodeGroupIds.length > 0) {
            byGroups = await HyUser.find({ groups: { $in: node.groups }, enabled: true, nodes: { $size: 0 } }).lean();
        } else {
            // Node has no groups — all users without group assignment
            byGroups = await HyUser.find({ enabled: true, nodes: { $size: 0 }, groups: { $size: 0 } }).lean();
        }
        // Merge and deduplicate by userId
        const seen = new Set();
        return [...byNodes, ...byGroups].filter(u => {
            if (seen.has(u.userId)) return false;
            seen.add(u.userId);
            return true;
        });
    }

    /**
     * Build xray api adu command for adding a user to an Xray inbound
     */
    _buildAddUserCmd(node, user) {
        const xray = node.xray || {};
        const apiPort = xray.apiPort || 61000;
        const inboundTag = xray.inboundTag || 'vless-in';
        const transport = xray.transport || 'tcp';
        const security = xray.security || 'reality';
        const email = `${user.userId}.${user.username || 'user'}`;
        const uuid = user.xrayUuid;
        let cmd = `xray api adu --server=127.0.0.1:${apiPort} -inbound-tag ${inboundTag} -id ${uuid} -email "${email}" -level 0`;
        if ((security === 'reality' || security === 'tls') && transport === 'tcp') {
            cmd += ` -flow "${xray.flow || 'xtls-rprx-vision'}"`;
        }
        return cmd;
    }

    /**
     * Build xray api rmu command for removing a user from an Xray inbound
     */
    _buildRemoveUserCmd(node, user) {
        const xray = node.xray || {};
        const apiPort = xray.apiPort || 61000;
        const inboundTag = xray.inboundTag || 'vless-in';
        const email = `${user.userId}.${user.username || 'user'}`;
        return `xray api rmu --server=127.0.0.1:${apiPort} -inbound-tag ${inboundTag} -email "${email}"`;
    }

    /**
     * Add a single user to a running Xray node via gRPC API (SSH exec)
     * No restart needed.
     */
    async addXrayUser(node, user) {
        if (!user.xrayUuid) {
            logger.warn(`[Xray] User ${user.userId} has no xrayUuid, skipping`);
            return false;
        }
        const ssh = new NodeSSH(node);
        try {
            await ssh.connect();
            const cmd = this._buildAddUserCmd(node, user);
            await ssh.exec(cmd);
            logger.info(`[Xray] Added user ${user.userId} to ${node.name}`);
            return true;
        } catch (error) {
            logger.error(`[Xray] addXrayUser ${node.name}/${user.userId}: ${error.message}`);
            return false;
        } finally {
            ssh.disconnect();
        }
    }

    /**
     * Remove a single user from a running Xray node via gRPC API (SSH exec)
     * No restart needed.
     */
    async removeXrayUser(node, user) {
        const ssh = new NodeSSH(node);
        try {
            await ssh.connect();
            const cmd = this._buildRemoveUserCmd(node, user);
            await ssh.exec(cmd);
            logger.info(`[Xray] Removed user ${user.userId} from ${node.name}`);
            return true;
        } catch (error) {
            logger.error(`[Xray] removeXrayUser ${node.name}/${user.userId}: ${error.message}`);
            return false;
        } finally {
            ssh.disconnect();
        }
    }

    /**
     * Add user to all active Xray nodes they belong to (fire-and-forget safe)
     */
    async addUserToAllXrayNodes(user) {
        const xrayNodes = await HyNode.find({ type: 'xray', active: true });
        for (const node of xrayNodes) {
            const nodeUsers = await this._getUsersForNode(node);
            const belongs = nodeUsers.some(u => u.userId === user.userId);
            if (belongs) {
                this.addXrayUser(node, user).catch(() => {});
            }
        }
    }

    /**
     * Remove user from all active Xray nodes (fire-and-forget safe)
     */
    async removeUserFromAllXrayNodes(user) {
        const xrayNodes = await HyNode.find({ type: 'xray', active: true });
        for (const node of xrayNodes) {
            this.removeXrayUser(node, user).catch(() => {});
        }
    }

    /**
     * Full config update for an Xray node — generates JSON with all users, uploads, restarts
     */
    async updateXrayNodeConfig(node) {
        logger.info(`[Xray Sync] Updating config for node ${node.name} (${node.ip})`);

        await HyNode.updateOne({ _id: node._id }, { $set: { status: 'syncing' } });

        const ssh = new NodeSSH(node);
        try {
            await ssh.connect();

            const users = await this._getUsersForNode(node);
            const configContent = configGenerator.generateXrayConfig(node, users);

            // Upload config.json
            await ssh.uploadContent(configContent, node.paths?.config || '/etc/xray/config.json');

            // Restart xray service
            await ssh.exec('systemctl restart xray');
            const statusResult = await ssh.exec('systemctl is-active xray 2>/dev/null || echo inactive').catch(() => ({ stdout: 'inactive' }));
            const isRunning = (statusResult.stdout || '').trim() === 'active';

            await HyNode.updateOne(
                { _id: node._id },
                {
                    $set: {
                        status: isRunning ? 'online' : 'error',
                        lastSync: new Date(),
                        lastError: isRunning ? '' : 'Xray service not running after sync',
                    },
                }
            );

            logger.info(`[Xray Sync] Node ${node.name}: config updated, ${users.length} users`);
            return true;
        } catch (error) {
            logger.error(`[Xray Sync] Node ${node.name} error: ${error.message}`);
            await HyNode.updateOne({ _id: node._id }, { $set: { status: 'error', lastError: error.message } });
            webhook.emit(webhook.EVENTS.NODE_ERROR, { nodeId: node._id, name: node.name, error: error.message });
            return false;
        } finally {
            ssh.disconnect();
        }
    }

    /**
     * Collect traffic stats from Xray node via SSH + xray api statsquery
     * Parses: user>>>userId.username>>>traffic>>>uplink/downlink
     */
    async collectXrayTrafficStats(node) {
        const xray = node.xray || {};
        const apiPort = xray.apiPort || 61000;

        const ssh = new NodeSSH(node);
        try {
            await ssh.connect();
            const execResult = await ssh.exec(
                `xray api statsquery --server=127.0.0.1:${apiPort} -pattern "user>>>" -reset 2>/dev/null || true`
            );
            const output = execResult.stdout || '';

            // Parse output lines: stat:<  name:"user>>>id.name>>>traffic>>>uplink"  value:12345  >
            const stats = {};
            const lineRe = /name:"user>>>([^>]+)>>>traffic>>>(uplink|downlink)"\s+value:(\d+)/g;
            let match;
            while ((match = lineRe.exec(output)) !== null) {
                const email = match[1];   // "userId.username"
                const direction = match[2]; // uplink | downlink
                const value = parseInt(match[3], 10) || 0;
                const userId = email.split('.')[0];
                if (!stats[userId]) stats[userId] = { tx: 0, rx: 0 };
                if (direction === 'uplink') stats[userId].tx += value;
                else stats[userId].rx += value;
            }

            if (Object.keys(stats).length === 0) return;

            let nodeTx = 0;
            let nodeRx = 0;
            const bulkOps = [];
            const now = new Date();

            for (const [userId, traffic] of Object.entries(stats)) {
                nodeTx += traffic.tx;
                nodeRx += traffic.rx;
                bulkOps.push({
                    updateOne: {
                        filter: { userId },
                        update: {
                            $inc: { 'traffic.tx': traffic.tx, 'traffic.rx': traffic.rx },
                            $set: { 'traffic.lastUpdate': now },
                        },
                    },
                });
            }

            if (bulkOps.length > 0) {
                const result = await HyUser.bulkWrite(bulkOps, { ordered: false });
                logger.debug(`[Xray Stats] ${node.name}: updated ${result.modifiedCount}/${bulkOps.length} users`);
                this._checkUserLimits(Object.keys(stats)).catch(() => {});
            }

            await HyNode.updateOne(
                { _id: node._id },
                {
                    $inc: { 'traffic.tx': nodeTx, 'traffic.rx': nodeRx },
                    $set: { 'traffic.lastUpdate': now },
                }
            );

            logger.info(`[Xray Stats] ${node.name}: ${Object.keys(stats).length} users, ↑${(nodeTx / 1024 / 1024).toFixed(1)}MB ↓${(nodeRx / 1024 / 1024).toFixed(1)}MB`);
        } catch (error) {
            logger.error(`[Xray Stats] ${node.name} error: ${error.message}`);
        } finally {
            ssh.disconnect();
        }
    }

    /**
     * Get online user count from Xray node via SSH + xray api statsquery (no reset)
     */
    async getXrayOnlineUsers(node) {
        const xray = node.xray || {};
        const apiPort = xray.apiPort || 61000;

        const ssh = new NodeSSH(node);
        try {
            await ssh.connect();

            // Check service is running first
            const activeResult = await ssh.exec('systemctl is-active xray 2>/dev/null || echo inactive').catch(() => ({ stdout: 'inactive' }));
            const active = (activeResult.stdout || '').trim();
            if (active !== 'active') {
                const prevNode = await HyNode.findOneAndUpdate(
                    { _id: node._id },
                    { $set: { onlineUsers: 0, status: 'offline' } }
                );
                if (prevNode && prevNode.status === 'online') {
                    webhook.emit(webhook.EVENTS.NODE_OFFLINE, { nodeId: node._id, name: node.name });
                }
                return 0;
            }

            // Count users with non-zero stats in last interval (approximate online)
            const statsResult = await ssh.exec(
                `xray api statsquery --server=127.0.0.1:${apiPort} -pattern "user>>>" 2>/dev/null || true`
            ).catch(() => ({ stdout: '' }));
            const output = statsResult.stdout || '';

            const activeUsers = new Set();
            const lineRe = /name:"user>>>([^>]+)>>>traffic>>>(uplink|downlink)"\s+value:(\d+)/g;
            let match;
            while ((match = lineRe.exec(output)) !== null) {
                if (parseInt(match[3], 10) > 0) {
                    activeUsers.add(match[1].split('.')[0]);
                }
            }
            const online = activeUsers.size;

            const prevNode = await HyNode.findOneAndUpdate(
                { _id: node._id },
                { $set: { onlineUsers: online, status: 'online' } }
            );

            if (prevNode && prevNode.status !== 'online') {
                webhook.emit(webhook.EVENTS.NODE_ONLINE, { nodeId: node._id, name: node.name });
            }

            if (online > 0) logger.info(`[Xray Stats] ${node.name}: ${online} online`);
            return online;
        } catch (error) {
            logger.warn(`[Xray Stats] ${node.name}: unavailable - ${error.message}`);
            const prevNode = await HyNode.findOneAndUpdate(
                { _id: node._id },
                { $set: { lastError: `Stats: ${error.message}` } }
            );
            if (prevNode && prevNode.status === 'online') {
                webhook.emit(webhook.EVENTS.NODE_OFFLINE, { nodeId: node._id, name: node.name, lastError: error.message });
            }
            return 0;
        } finally {
            ssh.disconnect();
        }
    }

    // ==================== HYSTERIA / COMMON METHODS ====================

    /**
     * Update config on a specific node (dispatches by type)
     */
    async updateNodeConfig(node) {
        if (node.type === 'xray') {
            return this.updateXrayNodeConfig(node);
        }
        return this._updateHysteriaNodeConfig(node);
    }

    /**
     * Update Hysteria config on a specific node
     */
    async _updateHysteriaNodeConfig(node) {
        logger.info(`[Sync] Updating config for node ${node.name} (${node.ip})`);
        
        await HyNode.updateOne(
            { _id: node._id },
            { $set: { status: 'syncing' } }
        );
        
        const ssh = new NodeSSH(node);
        
        try {
            await ssh.connect();
            
            // Use custom config or generate automatically
            let configContent;
            const customConfig = (node.customConfig || '').trim();
            if (node.useCustomConfig && customConfig && customConfig.length > 50) {
                // Basic validation: must contain listen and auth/tls/acme
                if (!customConfig.includes('listen:')) {
                    throw new Error('Custom config invalid: missing listen:');
                }
                if (!customConfig.includes('acme:') && !customConfig.includes('tls:')) {
                    throw new Error('Custom config invalid: missing acme: or tls:');
                }
                configContent = customConfig;
                logger.info(`[Sync] Using custom config for ${node.name}`);
            } else {
                if (node.useCustomConfig) {
                    logger.warn(`[Sync] Custom config for ${node.name} is empty or too short, using auto-generation`);
                }
                const authUrl = this.getAuthUrl();
                const settings = await Settings.get();
                const authInsecure = settings?.nodeAuth?.insecure ?? true;
                const useTlsFiles = node.useTlsFiles || false;
                configContent = configGenerator.generateNodeConfig(node, authUrl, { authInsecure, useTlsFiles });
            }
            
            // Update config on node
            const success = await ssh.updateConfig(configContent);
            
            if (success) {
                const isRunning = await ssh.checkHysteriaStatus();
                
                await HyNode.updateOne(
                    { _id: node._id },
                    {
                        $set: {
                            status: isRunning ? 'online' : 'error',
                            lastSync: new Date(),
                            lastError: isRunning ? '' : 'Service not running after sync',
                        }
                    }
                );
                
                logger.info(`[Sync] Node ${node.name}: config updated`);
                return true;
            } else {
                throw new Error('Failed to update config');
            }
        } catch (error) {
            logger.error(`[Sync] Node ${node.name} error: ${error.message}`);
            await HyNode.updateOne(
                { _id: node._id },
                { $set: { status: 'error', lastError: error.message } }
            );
            webhook.emit(webhook.EVENTS.NODE_ERROR, { nodeId: node._id, name: node.name, error: error.message });
            return false;
        } finally {
            ssh.disconnect();
        }
    }

    /**
     * Update configs on all active nodes (parallel, up to 5 concurrent)
     */
    async syncAllNodes() {
        if (this.isSyncing) {
            logger.warn('[Sync] Sync already in progress');
            return;
        }
        
        this.isSyncing = true;
        const syncStart = Date.now();
        logger.info('[Sync] Starting sync for all nodes');
        
        try {
            const nodes = await HyNode.find({ active: true });
            
            // Parallel sync with concurrency limit
            const CONCURRENCY = 5;
            for (let i = 0; i < nodes.length; i += CONCURRENCY) {
                const batch = nodes.slice(i, i + CONCURRENCY);
                await Promise.allSettled(
                    batch.map(node => this.updateNodeConfig(node))
                );
            }
            
            this.lastSyncTime = new Date();
            logger.info('[Sync] Sync completed');
            webhook.emit(webhook.EVENTS.SYNC_COMPLETED, {
                nodesCount: nodes.length,
                duration: Math.round((Date.now() - syncStart) / 1000),
            });
        } finally {
            this.isSyncing = false;
        }
    }

    /**
     * Collect traffic stats from node and update users (dispatches by type)
     */
    async collectTrafficStats(node) {
        if (node.type === 'xray') {
            return this.collectXrayTrafficStats(node);
        }
        return this._collectHysteriaTrafficStats(node);
    }

    /**
     * Collect traffic stats from Hysteria node via HTTP API
     * Uses bulkWrite for optimization (99% fewer MongoDB queries)
     */
    async _collectHysteriaTrafficStats(node) {
        try {
            if (!node.statsPort || !node.statsSecret) {
                return;
            }
            
            const url = `http://${node.ip}:${node.statsPort}/traffic?clear=true`;
            
            const response = await axios.get(url, {
                headers: { Authorization: node.statsSecret },
                timeout: 10000,
            });
            
            const stats = response.data;
            
            // Sum node traffic
            let nodeTx = 0;
            let nodeRx = 0;
            
            // Prepare bulk operations for all users
            const bulkOps = [];
            const now = new Date();
            
            for (const [userId, traffic] of Object.entries(stats)) {
                nodeTx += traffic.tx || 0;
                nodeRx += traffic.rx || 0;
                
                bulkOps.push({
                    updateOne: {
                        filter: { userId },
                        update: {
                            $inc: {
                                'traffic.tx': traffic.tx || 0,
                                'traffic.rx': traffic.rx || 0,
                            },
                            $set: { 'traffic.lastUpdate': now }
                        }
                    }
                });
            }
            
            // Execute bulk update (1 query instead of N)
            if (bulkOps.length > 0) {
                const result = await HyUser.bulkWrite(bulkOps, { ordered: false });
                logger.debug(`[Stats] ${node.name}: Bulk updated ${result.modifiedCount}/${bulkOps.length} users`);

                // Check traffic limits and expiry for affected users (fire-and-forget)
                this._checkUserLimits(Object.keys(stats)).catch(() => {});
            }
            
            // Update node traffic
            await HyNode.updateOne(
                { _id: node._id },
                {
                    $inc: {
                        'traffic.tx': nodeTx,
                        'traffic.rx': nodeRx,
                    },
                    $set: { 'traffic.lastUpdate': now }
                }
            );
            
            logger.info(`[Stats] ${node.name}: ${Object.keys(stats).length} users, traffic: ↑${(nodeTx / 1024 / 1024).toFixed(1)}MB ↓${(nodeRx / 1024 / 1024).toFixed(1)}MB`);
        } catch (error) {
            logger.error(`[Stats] ${node.name} error: ${error.message}`);
        }
    }

    /**
     * Get online users from node (dispatches by type)
     */
    async getOnlineUsers(node) {
        if (node.type === 'xray') {
            return this.getXrayOnlineUsers(node);
        }
        return this._getHysteriaOnlineUsers(node);
    }

    /**
     * Get online users from Hysteria node via HTTP Stats API
     */
    async _getHysteriaOnlineUsers(node) {
        try {
            // If Stats API not configured - skip, don't change status
            if (!node.statsPort || !node.statsSecret) {
                logger.debug(`[Stats] ${node.name}: Stats API not configured, skipping`);
                return 0;
            }
            
            const url = `http://${node.ip}:${node.statsPort}/online`;
            
            const response = await axios.get(url, {
                headers: { Authorization: node.statsSecret },
                timeout: 5000,
            });
            
            const online = Object.keys(response.data).length;
            
            const prevNode = await HyNode.findOneAndUpdate(
                { _id: node._id },
                { $set: { onlineUsers: online, status: 'online' } }
            );

            // Fire node.online if it was previously offline/error
            if (prevNode && prevNode.status !== 'online') {
                webhook.emit(webhook.EVENTS.NODE_ONLINE, { nodeId: node._id, name: node.name });
            }
            
            if (online > 0) {
                logger.info(`[Stats] ${node.name}: ${online} online`);
            }
            return online;
        } catch (error) {
            // Log error but DON'T change status to error
            // Error status should only be set for real node problems
            logger.warn(`[Stats] ${node.name}: Stats unavailable - ${error.message}`);
            
            // Update only lastError, don't touch status
            const prevNode = await HyNode.findOneAndUpdate(
                { _id: node._id },
                { $set: { lastError: `Stats: ${error.message}` } }
            );

            // Fire node.offline only if it was online before
            if (prevNode && prevNode.status === 'online') {
                webhook.emit(webhook.EVENTS.NODE_OFFLINE, { nodeId: node._id, name: node.name, lastError: error.message });
            }
            return 0;
        }
    }

    /**
     * Kick user from all nodes
     */
    async kickUser(userId) {
        const user = await HyUser.findOne({ userId }).populate('nodes', 'name ip statsPort statsSecret');
        
        if (!user) {
            return;
        }
        
        for (const node of user.nodes) {
            try {
                if (!node.statsPort || !node.statsSecret) continue;
                
                const url = `http://${node.ip}:${node.statsPort}/kick`;
                
                await axios.post(url, [userId], {
                    headers: {
                        Authorization: node.statsSecret,
                        'Content-Type': 'application/json',
                    },
                    timeout: 5000,
                });
                
                logger.info(`[Kick] ${userId} kicked from ${node.name}`);
            } catch (error) {
                logger.error(`[Kick] Kick error on ${node.name}: ${error.message}`);
            }
        }
    }

    /**
     * Collect stats from all nodes (parallel with concurrency limit)
     */
    async collectAllStats() {
        const nodes = await HyNode.find({ active: true });
        
        // Parallel processing with concurrency limit
        const CONCURRENCY = 5;
        for (let i = 0; i < nodes.length; i += CONCURRENCY) {
            const batch = nodes.slice(i, i + CONCURRENCY);
            await Promise.allSettled(
                batch.flatMap(node => [
                    this.collectTrafficStats(node),
                    this.getOnlineUsers(node)
                ])
            );
        }
        
        // Update last stats collection time
        this.lastSyncTime = new Date();
        
        // Invalidate traffic stats cache (data updated)
        await cache.invalidateTrafficStats();
    }

    /**
     * Health check all nodes (parallel)
     */
    async healthCheck() {
        const nodes = await HyNode.find({ active: true });
        
        // Parallel check with concurrency limit
        const CONCURRENCY = 5;
        for (let i = 0; i < nodes.length; i += CONCURRENCY) {
            const batch = nodes.slice(i, i + CONCURRENCY);
            await Promise.allSettled(
                batch.map(node => this.getOnlineUsers(node))
            );
        }
    }

    /**
     * Check traffic limits and expiry for a list of userIds after stats update.
     * Emits user.traffic_exceeded and user.expired webhooks only ONCE per user
     * (when they first cross the threshold, not on every subsequent cycle).
     *
     * Uses a simple in-memory Set to deduplicate across calls within a process lifetime.
     * The Set is cleared on process restart, which is acceptable — one extra notification
     * on redeploy is not a problem.
     */
    async _checkUserLimits(userIds) {
        if (!userIds || userIds.length === 0) return;

        const users = await HyUser.find(
            { userId: { $in: userIds }, enabled: true },
            { userId: 1, trafficLimit: 1, 'traffic.tx': 1, 'traffic.rx': 1, expireAt: 1 }
        ).lean();

        const now = new Date();
        for (const user of users) {
            // Traffic exceeded — emit only once per user per process lifetime
            if (user.trafficLimit > 0) {
                const used = (user.traffic?.tx || 0) + (user.traffic?.rx || 0);
                if (used >= user.trafficLimit && !this._notifiedTraffic.has(user.userId)) {
                    this._notifiedTraffic.add(user.userId);
                    webhook.emit(webhook.EVENTS.USER_TRAFFIC_EXCEEDED, {
                        userId: user.userId,
                        used,
                        limit: user.trafficLimit,
                    });
                } else if (used < user.trafficLimit) {
                    // Traffic was reset — allow future notifications
                    this._notifiedTraffic.delete(user.userId);
                }
            }
            // Expired — emit only once per user per process lifetime
            if (user.expireAt && new Date(user.expireAt) < now && !this._notifiedExpired.has(user.userId)) {
                this._notifiedExpired.add(user.userId);
                webhook.emit(webhook.EVENTS.USER_EXPIRED, {
                    userId: user.userId,
                    expiredAt: user.expireAt,
                });
            }
        }
    }

    /**
     * Setup port hopping on node
     */
    async setupPortHopping(node) {
        const ssh = new NodeSSH(node);
        
        try {
            await ssh.connect();
            await ssh.setupPortHopping(node.portRange);
            return true;
        } catch (error) {
            logger.error(`[PortHop] Error on ${node.name}: ${error.message}`);
            return false;
        } finally {
            ssh.disconnect();
        }
    }
}

module.exports = new SyncService();
