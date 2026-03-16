/**
 * Network topology visualization using cytoscape.js
 */

(function () {
    'use strict';

    if (typeof cytoscape === 'undefined') return;

    if (typeof cytoscapeDagre !== 'undefined') {
        cytoscape.use(cytoscapeDagre);
    }

    const i18n = window._networkI18n || {};

    const STATUS_COLORS = {
        online: '#22c55e',
        offline: '#64748b',
        error: '#ef4444',
        syncing: '#eab308',
        deployed: '#3b82f6',
        pending: '#475569',
    };

    // Node background colors by cascade role
    const ROLE_BG = {
        standalone: '#1e293b',
        entry:      '#1e1b4b',
        exit:       '#1c1400',
        relay:      '#1a0d2e',
    };

    const ROLE_BORDER_ACCENT = {
        standalone: '#334155',
        entry:      '#6366f1',
        exit:       '#f59e0b',
        relay:      '#8b5cf6',
    };

    const ROLE_LABELS = {
        standalone: i18n.roleStandalone || '',
        entry:      i18n.rolePortal     || 'PORTAL',
        relay:      i18n.roleRelay      || 'RELAY',
        exit:       i18n.roleBridge     || 'BRIDGE',
    };

    let cy = null;
    let refreshTimer = null;

    // ==================== INIT ====================

    function init() {
        cy = cytoscape({
            container: document.getElementById('cy'),
            style: getCytoscapeStyle(),
            layout: { name: 'preset' },
            minZoom: 0.2,
            maxZoom: 3,
            wheelSensitivity: 0.3,
            boxSelectionEnabled: false,
        });

        cy.on('tap', 'node', onNodeTap);
        cy.on('tap', 'edge', onEdgeTap);
        cy.on('tap', function (e) {
            if (e.target === cy) closeDrawer();
        });
        cy.on('dragfree', 'node', onNodeDragEnd);

        document.getElementById('btnAutoLayout').addEventListener('click', runAutoLayout);
        document.getElementById('btnFitView').addEventListener('click', function () { cy.fit(50); });
        document.getElementById('btnRefresh').addEventListener('click', loadTopology);
        document.getElementById('btnAddLink').addEventListener('click', openAddLinkModal);
        document.getElementById('drawerClose').addEventListener('click', closeDrawer);
        document.getElementById('modalClose').addEventListener('click', closeModal);
        document.getElementById('modalCancel').addEventListener('click', closeModal);
        document.getElementById('addLinkForm').addEventListener('submit', onAddLinkSubmit);

        loadTopology();
        refreshTimer = setInterval(refreshStatuses, 30000);

        // Resize observer to fix cytoscape canvas on container resize
        if (typeof ResizeObserver !== 'undefined') {
            const ro = new ResizeObserver(function () {
                if (cy) cy.resize();
            });
            const container = document.getElementById('cy');
            if (container) ro.observe(container);
        }

        window._networkResize = function () {
            if (cy) { cy.resize(); cy.fit(50); }
        };
    }

    // ==================== DATA LOADING ====================

    async function loadTopology() {
        showLoading(true);
        setEmptyState(false);
        try {
            const res = await fetch('/api/cascade/topology');
            if (!res.ok) throw new Error('Failed to load topology');
            const data = await res.json();
            renderGraph(data);
        } catch (err) {
            console.error('Topology load error:', err);
        } finally {
            showLoading(false);
        }
    }

    async function refreshStatuses() {
        try {
            const res = await fetch('/api/cascade/topology');
            if (!res.ok) return;
            const data = await res.json();

            for (const n of data.nodes) {
                const ele = cy.getElementById(n.data.id);
                if (ele.length) {
                    ele.data('status', n.data.status);
                    ele.data('onlineUsers', n.data.onlineUsers);
                }
            }
            for (const e of data.edges) {
                const ele = cy.getElementById(e.data.id);
                if (ele.length) {
                    ele.data('status', e.data.status);
                    ele.data('latencyMs', e.data.latencyMs);
                }
            }
        } catch (_) {}
    }

    function renderGraph(data) {
        cy.elements().remove();

        const isEmpty = (!data.nodes || data.nodes.length === 0) &&
                        (!data.edges || data.edges.length === 0);

        if (isEmpty) {
            setEmptyState(true);
            return;
        }
        setEmptyState(false);

        const elements = [];

        for (const n of data.nodes) {
            const role = n.data.cascadeRole || 'standalone';
            const roleLabel = ROLE_LABELS[role] || '';
            const displayLabel = (n.data.flag ? n.data.flag + ' ' : '') + (n.data.label || n.data.ip || '');
            const subtitle = n.data.ip + (n.data.onlineUsers ? ' · ' + n.data.onlineUsers : '');

            elements.push({
                group: 'nodes',
                data: {
                    ...n.data,
                    roleLabel,
                    displayLabel,
                    subtitle,
                    roleBg: ROLE_BG[role] || ROLE_BG.standalone,
                    roleAccent: ROLE_BORDER_ACCENT[role] || ROLE_BORDER_ACCENT.standalone,
                },
                position: n.position || undefined,
            });
        }

        for (const e of data.edges) {
            elements.push({
                group: 'edges',
                data: {
                    ...e.data,
                    edgeLabel: buildEdgeLabel(e.data),
                },
            });
        }

        cy.add(elements);

        const hasPositions = data.nodes.some(n => n.position);
        if (hasPositions) {
            cy.fit(50);
        } else {
            runAutoLayout();
        }
    }

    function buildEdgeLabel(data) {
        const parts = [];
        if (data.tunnelProtocol) parts.push(data.tunnelProtocol.toUpperCase());
        if (data.tunnelPort) parts.push(':' + data.tunnelPort);
        if (data.latencyMs != null) parts.push(data.latencyMs + 'ms');
        return parts.join(' ') || '';
    }

    // ==================== CYTOSCAPE STYLE ====================

    function getCytoscapeStyle() {
        return [
            {
                selector: 'node',
                style: {
                    'shape': 'round-rectangle',
                    'width': 160,
                    'height': 52,
                    'background-color': function (ele) {
                        return ele.data('roleBg') || ROLE_BG.standalone;
                    },
                    'border-width': 2,
                    'border-color': function (ele) {
                        const status = ele.data('status');
                        if (status === 'online') return STATUS_COLORS.online;
                        if (status === 'error') return STATUS_COLORS.error;
                        if (status === 'offline') return ele.data('roleAccent') || ROLE_BORDER_ACCENT.standalone;
                        return ele.data('roleAccent') || ROLE_BORDER_ACCENT.standalone;
                    },
                    'label': function (ele) {
                        return ele.data('displayLabel') || ele.data('label') || ele.data('ip') || '';
                    },
                    'text-valign': 'center',
                    'text-halign': 'center',
                    'color': '#e2e8f0',
                    'font-size': '12px',
                    'font-family': 'Inter, system-ui, sans-serif',
                    'font-weight': 600,
                    'text-wrap': 'ellipsis',
                    'text-max-width': '140px',
                    'overlay-opacity': 0,
                },
            },
            {
                selector: 'node[subtitle]',
                style: {
                    'height': 60,
                    'label': function (ele) {
                        const main = ele.data('displayLabel') || ele.data('label') || '';
                        const sub = ele.data('subtitle') || '';
                        return main + '\n' + sub;
                    },
                    'font-size': '12px',
                    'text-wrap': 'wrap',
                    'text-max-width': '145px',
                    'line-height': 1.5,
                },
            },
            {
                selector: 'node[roleLabel]',
                style: {
                    'height': 70,
                    'label': function (ele) {
                        const role = ele.data('roleLabel');
                        const main = ele.data('displayLabel') || ele.data('label') || '';
                        const sub = ele.data('subtitle') || '';
                        const prefix = role ? '[' + role + '] ' : '';
                        return prefix + main + '\n' + sub;
                    },
                    'font-size': '11px',
                    'text-wrap': 'wrap',
                    'text-max-width': '145px',
                    'line-height': 1.5,
                    'color': function (ele) {
                        const role = ele.data('cascadeRole') || 'standalone';
                        if (role === 'entry') return '#a5b4fc';
                        if (role === 'exit') return '#fcd34d';
                        if (role === 'relay') return '#c4b5fd';
                        return '#e2e8f0';
                    },
                },
            },
            {
                selector: 'node:selected',
                style: {
                    'border-width': 3,
                    'border-color': '#6366f1',
                    'background-color': function (ele) {
                        const role = ele.data('cascadeRole') || 'standalone';
                        const base = ROLE_BG[role] || ROLE_BG.standalone;
                        return base;
                    },
                    'overlay-opacity': 0.06,
                    'overlay-color': '#6366f1',
                },
            },
            {
                selector: 'node:active',
                style: { 'overlay-opacity': 0 },
            },
            {
                selector: 'edge',
                style: {
                    'width': 1.5,
                    'line-color': function (ele) {
                        return STATUS_COLORS[ele.data('status')] || STATUS_COLORS.pending;
                    },
                    'target-arrow-color': function (ele) {
                        return STATUS_COLORS[ele.data('status')] || STATUS_COLORS.pending;
                    },
                    'target-arrow-shape': 'triangle',
                    'curve-style': 'bezier',
                    'arrow-scale': 1.1,
                    'label': function (ele) { return ele.data('edgeLabel') || ''; },
                    'font-size': '10px',
                    'font-family': 'JetBrains Mono, monospace',
                    'color': '#94a3b8',
                    'text-background-color': '#0f172a',
                    'text-background-opacity': 0.85,
                    'text-background-padding': '3px',
                    'text-rotation': 'autorotate',
                    'overlay-opacity': 0,
                },
            },
            {
                selector: 'edge[status = "online"]',
                style: {
                    'width': 2.5,
                    'line-style': 'dashed',
                    'line-dash-pattern': [8, 4],
                },
            },
            {
                selector: 'edge[status = "deployed"]',
                style: {
                    'width': 2,
                    'line-style': 'solid',
                },
            },
            {
                selector: 'edge[status = "syncing"]',
                style: {
                    'width': 2,
                    'line-style': 'dashed',
                    'line-dash-pattern': [4, 4],
                },
            },
            {
                selector: 'edge:selected',
                style: {
                    'width': 3,
                    'line-color': '#6366f1',
                    'target-arrow-color': '#6366f1',
                },
            },
        ];
    }

    // ==================== LAYOUT ====================

    function runAutoLayout() {
        const layout = cy.layout({
            name: 'dagre',
            rankDir: 'LR',
            nodeSep: 70,
            rankSep: 140,
            edgeSep: 30,
            animate: true,
            animationDuration: 350,
            fit: true,
            padding: 60,
        });
        layout.run();
    }

    // ==================== INTERACTIONS ====================

    function onNodeTap(evt) {
        const node = evt.target;
        const d = node.data();
        const statusClass = d.status || 'offline';
        const roleLabel = d.roleLabel ? `<span class="drawer-role-badge role-${d.cascadeRole}">${d.roleLabel}</span>` : '';

        const html = `
            <div class="drawer-field">
                <div class="drawer-label"><i class="ti ti-activity"></i> ${i18n.drawerStatus || 'Status'}</div>
                <div class="drawer-status ${statusClass}">&#9679; ${d.status || 'unknown'}${roleLabel}</div>
            </div>
            <div class="drawer-field">
                <div class="drawer-label"><i class="ti ti-network"></i> ${i18n.drawerIP || 'IP'}</div>
                <div class="drawer-value">${d.ip || '—'}</div>
            </div>
            <div class="drawer-field">
                <div class="drawer-label"><i class="ti ti-cpu"></i> ${i18n.drawerType || 'Type'}</div>
                <div class="drawer-value">${d.type || '—'}</div>
            </div>
            <div class="drawer-field">
                <div class="drawer-label"><i class="ti ti-topology-star-3"></i> ${i18n.drawerRole || 'Role'}</div>
                <div class="drawer-value">${d.cascadeRole || 'standalone'}</div>
            </div>
            <div class="drawer-field">
                <div class="drawer-label"><i class="ti ti-users"></i> ${i18n.drawerOnline || 'Online Users'}</div>
                <div class="drawer-value">${d.onlineUsers || 0}</div>
            </div>
            <div class="drawer-field">
                <div class="drawer-label"><i class="ti ti-plug"></i> ${i18n.drawerPort || 'Port'}</div>
                <div class="drawer-value">${d.port || '—'}</div>
            </div>
            <div class="drawer-actions">
                <a href="/panel/nodes/${d.id}" class="btn btn-sm btn-outline"><i class="ti ti-external-link"></i> ${i18n.openNode || 'Open Node'}</a>
            </div>
        `;

        document.getElementById('drawerTitle').innerHTML = (d.flag ? d.flag + ' ' : '') + (d.label || '');
        document.getElementById('drawerBody').innerHTML = html;
        document.getElementById('nodeDrawer').classList.add('open');
    }

    function onEdgeTap(evt) {
        const edge = evt.target;
        const d = edge.data();
        const statusClass = d.status || 'pending';
        const linkId = d.linkId;

        const html = `
            <div class="drawer-field">
                <div class="drawer-label"><i class="ti ti-activity"></i> ${i18n.drawerStatus || 'Status'}</div>
                <div class="drawer-status ${statusClass}">&#9679; ${d.status || 'pending'}</div>
            </div>
            <div class="drawer-field">
                <div class="drawer-label"><i class="ti ti-plug"></i> ${i18n.drawerTunnelPort || 'Tunnel Port'}</div>
                <div class="drawer-value">${d.tunnelPort || '—'}</div>
            </div>
            <div class="drawer-field">
                <div class="drawer-label"><i class="ti ti-arrows-exchange"></i> ${i18n.drawerProtocolTransport || 'Protocol / Transport'}</div>
                <div class="drawer-value">${(d.tunnelProtocol || 'vless').toUpperCase()} / ${d.tunnelTransport || 'tcp'}</div>
            </div>
            <div class="drawer-field">
                <div class="drawer-label"><i class="ti ti-clock"></i> ${i18n.drawerLatency || 'Latency'}</div>
                <div class="drawer-value">${d.latencyMs != null ? d.latencyMs + ' ms' : '—'}</div>
            </div>
            <div class="drawer-actions">
                <button class="btn btn-sm btn-success" id="btnDeploy" onclick="window._cascadeDeploy('${linkId}')">
                    <i class="ti ti-upload"></i> ${i18n.deploy || 'Deploy'}
                </button>
                <button class="btn btn-sm btn-outline" id="btnUndeploy" onclick="window._cascadeUndeploy('${linkId}')">
                    <i class="ti ti-upload-off"></i> ${i18n.undeploy || 'Undeploy'}
                </button>
                <button class="btn btn-sm btn-danger" id="btnDelete" onclick="window._cascadeDelete('${linkId}')">
                    <i class="ti ti-trash"></i> ${i18n.delete || 'Delete'}
                </button>
            </div>
        `;

        document.getElementById('drawerTitle').textContent = d.label || 'Cascade Link';
        document.getElementById('drawerBody').innerHTML = html;
        document.getElementById('nodeDrawer').classList.add('open');
    }

    function closeDrawer() {
        document.getElementById('nodeDrawer').classList.remove('open');
        cy.elements(':selected').unselect();
    }

    let positionSaveTimer = null;
    function onNodeDragEnd() {
        clearTimeout(positionSaveTimer);
        positionSaveTimer = setTimeout(saveAllPositions, 500);
    }

    async function saveAllPositions() {
        const positions = cy.nodes().map(function (n) {
            const pos = n.position();
            return { id: n.data('id'), x: Math.round(pos.x), y: Math.round(pos.y) };
        });

        try {
            await fetch('/api/cascade/topology/positions', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ positions }),
            });
        } catch (_) {}
    }

    // ==================== ADD LINK MODAL ====================

    async function openAddLinkModal() {
        const modal = document.getElementById('addLinkModal');
        const portalSelect = document.getElementById('selectPortal');
        const bridgeSelect = document.getElementById('selectBridge');

        try {
            const res = await fetch('/api/nodes');
            if (!res.ok) throw new Error('Failed to fetch nodes');
            const nodes = await res.json();

            const options = nodes.map(function (n) {
                return '<option value="' + n._id + '">' + (n.flag || '') + ' ' + n.name + ' (' + n.ip + ')</option>';
            }).join('');

            portalSelect.innerHTML = '<option value="">' + (i18n.selectPortal || '— Select Portal —') + '</option>' + options;
            bridgeSelect.innerHTML = '<option value="">' + (i18n.selectBridge || '— Select Bridge —') + '</option>' + options;
        } catch (err) {
            const errMsg = '<option value="">' + (i18n.errorLoadingNodes || 'Error loading nodes') + '</option>';
            portalSelect.innerHTML = errMsg;
            bridgeSelect.innerHTML = errMsg;
        }

        modal.classList.add('active');
    }

    function closeModal() {
        document.getElementById('addLinkModal').classList.remove('active');
        document.getElementById('addLinkForm').reset();
    }

    async function onAddLinkSubmit(e) {
        e.preventDefault();
        const form = e.target;
        const submitBtn = form.querySelector('[type="submit"]');
        const data = {
            name: form.name.value,
            portalNodeId: form.portalNodeId.value,
            bridgeNodeId: form.bridgeNodeId.value,
            tunnelPort: parseInt(form.tunnelPort.value) || 10086,
            tunnelProtocol: form.tunnelProtocol.value,
            tunnelTransport: form.tunnelTransport.value,
            tunnelSecurity: form.tunnelSecurity.value,
        };

        if (!data.name || !data.portalNodeId || !data.bridgeNodeId) {
            alert(i18n.fillRequired || 'Please fill in all required fields');
            return;
        }

        submitBtn.disabled = true;
        submitBtn.innerHTML = '<i class="ti ti-loader-2 spin"></i>';

        try {
            const res = await fetch('/api/cascade/links', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(data),
            });

            if (!res.ok) {
                const err = await res.json();
                showToast(i18n.networkError + ': ' + (err.error || 'Unknown error'), 'error');
                return;
            }

            closeModal();
            loadTopology();
        } catch (err) {
            showToast((i18n.networkError || 'Error') + ': ' + err.message, 'error');
        } finally {
            submitBtn.disabled = false;
            submitBtn.innerHTML = '<i class="ti ti-plus"></i> ' + (window._networkI18n?.createLink || 'Create');
        }
    }

    // ==================== CASCADE ACTIONS ====================

    function setActionButtonsLoading(msg) {
        ['btnDeploy', 'btnUndeploy', 'btnDelete'].forEach(function (id) {
            const btn = document.getElementById(id);
            if (btn) btn.disabled = true;
        });
        const drawerBody = document.getElementById('drawerBody');
        const existingLoader = drawerBody && drawerBody.querySelector('.drawer-loading');
        if (!existingLoader && drawerBody) {
            const loader = document.createElement('div');
            loader.className = 'drawer-loading';
            loader.innerHTML = '<i class="ti ti-loader-2 spin"></i> ' + msg;
            drawerBody.appendChild(loader);
        }
    }

    function resetActionButtons() {
        ['btnDeploy', 'btnUndeploy', 'btnDelete'].forEach(function (id) {
            const btn = document.getElementById(id);
            if (btn) btn.disabled = false;
        });
        const loader = document.querySelector('.drawer-loading');
        if (loader) loader.remove();
    }

    window._cascadeDeploy = async function (linkId) {
        if (!confirm(i18n.confirmDeploy || 'Deploy this cascade link?')) return;
        setActionButtonsLoading(i18n.deploying || 'Deploying...');

        // Optimistic: mark edge as syncing
        const edge = cy.edges().filter(function (e) { return e.data('linkId') === linkId; });
        const prevStatus = edge.length ? edge.data('status') : null;
        if (edge.length) edge.data('status', 'syncing');

        try {
            const res = await fetch('/api/cascade/links/' + linkId + '/deploy', { method: 'POST' });
            const data = await res.json();
            if (data.success) {
                showToast(i18n.deploySuccess || 'Deployed');
                loadTopology();
                closeDrawer();
            } else {
                if (edge.length && prevStatus) edge.data('status', prevStatus);
                showToast((i18n.deployFailed || 'Deploy failed') + ': ' + (data.error || ''), 'error');
            }
        } catch (err) {
            if (edge.length && prevStatus) edge.data('status', prevStatus);
            showToast((i18n.networkError || 'Error') + ': ' + err.message, 'error');
        } finally {
            resetActionButtons();
        }
    };

    window._cascadeUndeploy = async function (linkId) {
        if (!confirm(i18n.confirmUndeploy || 'Undeploy this cascade link?')) return;
        setActionButtonsLoading(i18n.undeploying || 'Undeploying...');

        const edge = cy.edges().filter(function (e) { return e.data('linkId') === linkId; });
        if (edge.length) edge.data('status', 'syncing');

        try {
            await fetch('/api/cascade/links/' + linkId + '/undeploy', { method: 'POST' });
            showToast(i18n.undeploySuccess || 'Undeployed');
            loadTopology();
            closeDrawer();
        } catch (err) {
            showToast((i18n.networkError || 'Error') + ': ' + err.message, 'error');
        } finally {
            resetActionButtons();
        }
    };

    window._cascadeDelete = async function (linkId) {
        if (!confirm(i18n.confirmDeleteLink || 'Delete this cascade link?')) return;
        setActionButtonsLoading(i18n.deleting || 'Deleting...');

        try {
            await fetch('/api/cascade/links/' + linkId, { method: 'DELETE' });
            showToast(i18n.deleteSuccess || 'Deleted');
            loadTopology();
            closeDrawer();
        } catch (err) {
            showToast((i18n.networkError || 'Error') + ': ' + err.message, 'error');
        } finally {
            resetActionButtons();
        }
    };

    // ==================== HELPERS ====================

    function showLoading(show) {
        let el = document.querySelector('.network-loading');
        if (show && !el) {
            el = document.createElement('div');
            el.className = 'network-loading';
            el.innerHTML = '<div class="spinner"></div> ' + (i18n.loadingTopology || 'Loading...');
            const container = document.querySelector('.network-container');
            if (container) container.appendChild(el);
        } else if (!show && el) {
            el.remove();
        }
    }

    function setEmptyState(show) {
        const el = document.getElementById('networkEmpty');
        const legend = document.getElementById('networkLegend');
        if (el) el.style.display = show ? 'flex' : 'none';
        if (legend) legend.style.display = show ? 'none' : '';
    }

    function showToast(message, type) {
        // Use the shared toast from nodes.ejs if available
        if (typeof window.showToast === 'function') {
            window.showToast(message, type || 'success');
            return;
        }
        // Fallback: find or create toast element
        let toast = document.getElementById('toast');
        if (!toast) {
            toast = document.createElement('div');
            toast.id = 'toast';
            toast.className = 'toast';
            document.body.appendChild(toast);
        }
        toast.textContent = message;
        toast.className = 'toast show ' + (type || 'success');
        setTimeout(function () { toast.className = 'toast'; }, 3500);
    }

    // ==================== START ====================

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
