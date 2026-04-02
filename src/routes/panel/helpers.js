/**
 * Shared helpers for panel routes.
 * Form parsers, SSH utils, render engine, middleware, TOTP utilities.
 */

const express = require('express');
const rateLimit = require('express-rate-limit');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const ejs = require('ejs');
const { Client: SSHClient } = require('ssh2');

const cryptoService = require('../../services/cryptoService');
const totpService = require('../../services/totpService');
const config = require('../../../config');
const logger = require('../../utils/logger');
const { parseDurationSeconds } = require('../../utils/helpers');

// Compiled template cache (production only)
const templateCache = new Map();

// Multer for backup file uploads
const backupUpload = multer({
    dest: '/tmp/backup-uploads/',
    limits: { fileSize: 500 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        if (file.originalname.endsWith('.tar.gz') || file.originalname.endsWith('.tgz')) {
            cb(null, true);
        } else {
            cb(new Error('Only .tar.gz files are allowed'));
        }
    }
});

// ─── SSH Helpers ─────────────────────────────────────────────────────────────

function buildSshKeyFilename(node) {
    const safe = (value, fallback) => {
        const normalized = String(value || '')
            .trim()
            .replace(/[^a-zA-Z0-9._-]+/g, '-')
            .replace(/-+/g, '-')
            .replace(/^-|-$/g, '');
        return normalized || fallback;
    };

    return `${safe(node.name, 'node')}-${safe(node.ip, 'unknown')}.key`;
}

function connectNodeSSH(node) {
    return new Promise((resolve, reject) => {
        const client = new SSHClient();
        const connConfig = {
            host: node.ip,
            port: node.ssh?.port || 22,
            username: node.ssh?.username || 'root',
            readyTimeout: 20000,
        };
        if (node.ssh?.privateKey) {
            connConfig.privateKey = cryptoService.decryptPrivateKey(node.ssh.privateKey);
        } else if (node.ssh?.password) {
            connConfig.password = cryptoService.decryptSafe(node.ssh.password);
        } else {
            return reject(new Error('SSH credentials not configured'));
        }
        client.on('ready', () => resolve(client));
        client.on('error', (err) => reject(err));
        client.connect(connConfig);
    });
}

// ─── Form Parsers ────────────────────────────────────────────────────────────

function parseXrayFormFields(body) {
    const xray = {};

    if (body['xray.transport']) xray.transport = body['xray.transport'];
    if (body['xray.security']) xray.security = body['xray.security'];
    if (body['xray.flow'] !== undefined) xray.flow = body['xray.flow'];
    if (body['xray.fingerprint']) xray.fingerprint = body['xray.fingerprint'];

    if (body['xray.alpn'] !== undefined) {
        const alpnStr = body['xray.alpn'].trim();
        xray.alpn = alpnStr ? alpnStr.split(',').map(s => s.trim()).filter(Boolean) : [];
    }

    if (body['xray.realityDest']) xray.realityDest = body['xray.realityDest'];
    if (body['xray.realityPrivateKey'] !== undefined) xray.realityPrivateKey = body['xray.realityPrivateKey'];
    if (body['xray.realityPublicKey'] !== undefined) xray.realityPublicKey = body['xray.realityPublicKey'];
    if (body['xray.realitySpiderX'] !== undefined) xray.realitySpiderX = body['xray.realitySpiderX'];

    if (body['xray.realitySni']) {
        xray.realitySni = body['xray.realitySni']
            .split(',').map(s => s.trim()).filter(Boolean);
    }
    if (body['xray.realityShortIds'] !== undefined) {
        xray.realityShortIds = body['xray.realityShortIds']
            .split(',').map(s => s.trim());
        if (xray.realityShortIds.length === 0) xray.realityShortIds = [''];
    }

    if (body['xray.wsPath'] !== undefined) xray.wsPath = body['xray.wsPath'];
    if (body['xray.wsHost'] !== undefined) xray.wsHost = body['xray.wsHost'];
    if (body['xray.grpcServiceName']) xray.grpcServiceName = body['xray.grpcServiceName'];
    if (body['xray.xhttpPath'] !== undefined) xray.xhttpPath = body['xray.xhttpPath'];
    if (body['xray.xhttpHost'] !== undefined) xray.xhttpHost = body['xray.xhttpHost'];
    if (body['xray.xhttpMode']) xray.xhttpMode = body['xray.xhttpMode'];
    if (body['xray.apiPort']) xray.apiPort = parseInt(body['xray.apiPort']) || 61000;

    return xray;
}

function parseBool(body, key, defaultValue = false) {
    if (body[key] === undefined) return defaultValue;
    const v = Array.isArray(body[key]) ? body[key][body[key].length - 1] : body[key];
    return v === 'on' || v === 'true' || v === true || v === '1';
}

function parseHeaderMap(raw, fallback = {}) {
    const text = (raw || '').trim();
    if (!text) return fallback;
    const result = {};
    text.split('\n').forEach(line => {
        const row = line.trim();
        if (!row) return;
        const idx = row.indexOf(':');
        if (idx <= 0) return;
        const key = row.slice(0, idx).trim().toLowerCase();
        const value = row.slice(idx + 1).trim();
        if (!key) return;
        result[key] = value;
    });
    return Object.keys(result).length > 0 ? result : fallback;
}

function parseJSONObjectWithStatus(raw, fallback = {}) {
    const text = (raw || '').trim();
    if (!text) {
        return { value: fallback, valid: true };
    }
    try {
        const parsed = JSON.parse(text);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            return { value: fallback, valid: false };
        }
        return { value: parsed, valid: true };
    } catch (_) {
        return { value: fallback, valid: false };
    }
}

function parseIntegerOrDefault(raw, defaultValue) {
    const value = parseInt(raw, 10);
    return Number.isFinite(value) ? value : defaultValue;
}

function normalizeTextareaNewlines(value) {
    return String(value || '').replace(/\r\n?/g, '\n');
}

const DEFAULT_INLINE_ACL_RULES = [
    'reject(geoip:cn)',
    'reject(geoip:private)',
];

function parseAclRulesInput(raw) {
    return String(raw || '')
        .split('\n')
        .map(line => line.trim())
        .filter(Boolean);
}

function getHysteriaAclInlineState(node) {
    if (!node || node.type === 'xray') {
        return { editable: true, reason: '' };
    }
    const aclEnabled = node.acl?.enabled !== false;
    const aclType = node.acl?.type || 'inline';
    if (!aclEnabled) return { editable: false, reason: 'disabled' };
    if (aclType === 'file') return { editable: false, reason: 'file' };
    return { editable: true, reason: '' };
}

function parseHysteriaFormFields(body) {
    const hasDomain = !!String(body.domain || '').trim();
    const acmeAdvancedEnabled = parseBool(body, 'acme.advanced.enabled', false) && hasDomain;
    const bandwidthEnabled = parseBool(body, 'bandwidth.enabled', false);
    const udpOptionsEnabled = parseBool(body, 'udp.options.enabled', false);
    const sniffEnabled = parseBool(body, 'sniff.enabled', false);
    const quicEnabled = parseBool(body, 'quic.enabled', false);
    const resolverEnabled = parseBool(body, 'resolver.enabled', false);
    const aclEnabled = parseBool(body, 'acl.enabled', true);
    const aclType = body['acl.type'] === 'file' ? 'file' : 'inline';
    const aclInlineRules = parseAclRulesInput(body['acl.inlineRules'] || body.aclRules);
    const aclRules = aclEnabled && aclType === 'inline'
        ? (aclInlineRules.length > 0 ? aclInlineRules : DEFAULT_INLINE_ACL_RULES.slice())
        : aclInlineRules;

    const acmeDnsConfigParsed = acmeAdvancedEnabled
        ? parseJSONObjectWithStatus(body['acme.dns.config'], {})
        : { value: {}, valid: true };
    const masqueradeType = body['masquerade.type'] === 'string' ? 'string' : 'proxy';

    const masquerade = {
        type: masqueradeType,
        proxy: {
            url: (body['masquerade.proxy.url'] || '').trim() || 'https://www.google.com',
            rewriteHost: parseBool(body, 'masquerade.proxy.rewriteHost', false),
            insecure: parseBool(body, 'masquerade.proxy.insecure', false),
        },
        string: {
            content: normalizeTextareaNewlines(body['masquerade.string.content'] || 'Service Unavailable'),
            headers: parseHeaderMap(body['masquerade.string.headers'], { 'content-type': 'text/plain' }),
            statusCode: parseInt(body['masquerade.string.statusCode'], 10) || 503,
        },
        listenHTTP: (body['masquerade.listenHTTP'] || '').trim(),
        listenHTTPS: (body['masquerade.listenHTTPS'] || '').trim(),
        forceHTTPS: parseBool(body, 'masquerade.forceHTTPS', false),
    };

    return {
        hopInterval: (body.hopInterval || '').trim(),
        acme: {
            email: hasDomain ? (body['acme.email'] || '').trim() : '',
            ca: hasDomain ? ((body['acme.ca'] || 'letsencrypt').trim() || 'letsencrypt') : '',
            listenHost: acmeAdvancedEnabled ? ((body['acme.listenHost'] || '').trim()) : '',
            type: acmeAdvancedEnabled ? (body['acme.type'] || '').trim() : '',
            httpAltPort: acmeAdvancedEnabled ? parseIntegerOrDefault(body['acme.httpAltPort'], 0) : 0,
            tlsAltPort: acmeAdvancedEnabled ? parseIntegerOrDefault(body['acme.tlsAltPort'], 0) : 0,
            dnsName: acmeAdvancedEnabled ? (body['acme.dns.name'] || '').trim() : '',
            dnsConfig: acmeAdvancedEnabled ? acmeDnsConfigParsed.value : {},
        },
        acmeDnsConfigValid: acmeDnsConfigParsed.valid,
        bandwidth: {
            up: bandwidthEnabled ? (body['bandwidth.up'] || '').trim() : '',
            down: bandwidthEnabled ? (body['bandwidth.down'] || '').trim() : '',
        },
        ignoreClientBandwidth: bandwidthEnabled ? parseBool(body, 'ignoreClientBandwidth', false) : false,
        speedTest: parseBool(body, 'speedTest', false),
        disableUDP: udpOptionsEnabled ? parseBool(body, 'disableUDP', false) : false,
        udpIdleTimeout: udpOptionsEnabled ? (body['udpIdleTimeout'] || '').trim() : '',
        sniff: {
            enabled: sniffEnabled,
            enable: parseBool(body, 'sniff.enable', true),
            timeout: sniffEnabled ? ((body['sniff.timeout'] || '2s').trim() || '2s') : '2s',
            rewriteDomain: sniffEnabled ? parseBool(body, 'sniff.rewriteDomain', false) : false,
            tcpPorts: sniffEnabled ? ((body['sniff.tcpPorts'] || '80,443,8000-9000').trim() || '80,443,8000-9000') : '80,443,8000-9000',
            udpPorts: sniffEnabled ? ((body['sniff.udpPorts'] || '443,80,53').trim() || '443,80,53') : '443,80,53',
        },
        quic: {
            enabled: quicEnabled,
            initStreamReceiveWindow: quicEnabled ? parseIntegerOrDefault(body['quic.initStreamReceiveWindow'], 8388608) : 8388608,
            maxStreamReceiveWindow: quicEnabled ? parseIntegerOrDefault(body['quic.maxStreamReceiveWindow'], 8388608) : 8388608,
            initConnReceiveWindow: quicEnabled ? parseIntegerOrDefault(body['quic.initConnReceiveWindow'], 20971520) : 20971520,
            maxConnReceiveWindow: quicEnabled ? parseIntegerOrDefault(body['quic.maxConnReceiveWindow'], 20971520) : 20971520,
            maxIdleTimeout: quicEnabled ? ((body['quic.maxIdleTimeout'] || '60s').trim() || '60s') : '60s',
            maxIncomingStreams: quicEnabled ? parseIntegerOrDefault(body['quic.maxIncomingStreams'], 256) : 256,
            disablePathMTUDiscovery: quicEnabled ? parseBool(body, 'quic.disablePathMTUDiscovery', false) : false,
        },
        resolver: {
            enabled: resolverEnabled,
            type: resolverEnabled ? ((body['resolver.type'] || 'udp').trim() || 'udp') : 'udp',
            udpAddr: resolverEnabled ? ((body['resolver.udp.addr'] || '8.8.4.4:53').trim() || '8.8.4.4:53') : '8.8.4.4:53',
            udpTimeout: resolverEnabled ? ((body['resolver.udp.timeout'] || '4s').trim() || '4s') : '4s',
            tcpAddr: resolverEnabled ? ((body['resolver.tcp.addr'] || '8.8.8.8:53').trim() || '8.8.8.8:53') : '8.8.8.8:53',
            tcpTimeout: resolverEnabled ? ((body['resolver.tcp.timeout'] || '4s').trim() || '4s') : '4s',
            tlsAddr: resolverEnabled ? ((body['resolver.tls.addr'] || '1.1.1.1:853').trim() || '1.1.1.1:853') : '1.1.1.1:853',
            tlsTimeout: resolverEnabled ? ((body['resolver.tls.timeout'] || '10s').trim() || '10s') : '10s',
            tlsSni: resolverEnabled ? ((body['resolver.tls.sni'] || 'cloudflare-dns.com').trim() || 'cloudflare-dns.com') : 'cloudflare-dns.com',
            tlsInsecure: resolverEnabled ? parseBool(body, 'resolver.tls.insecure', false) : false,
            httpsAddr: resolverEnabled ? ((body['resolver.https.addr'] || '1.1.1.1:443').trim() || '1.1.1.1:443') : '1.1.1.1:443',
            httpsTimeout: resolverEnabled ? ((body['resolver.https.timeout'] || '10s').trim() || '10s') : '10s',
            httpsSni: resolverEnabled ? ((body['resolver.https.sni'] || 'cloudflare-dns.com').trim() || 'cloudflare-dns.com') : 'cloudflare-dns.com',
            httpsInsecure: resolverEnabled ? parseBool(body, 'resolver.https.insecure', false) : false,
        },
        masquerade,
        acl: {
            enabled: aclEnabled,
            type: aclEnabled ? aclType : 'inline',
            file: aclEnabled ? (body['acl.file'] || '').trim() : '',
            geoip: aclEnabled ? (body['acl.geoip'] || '').trim() : '',
            geosite: aclEnabled ? (body['acl.geosite'] || '').trim() : '',
            geoUpdateInterval: aclEnabled ? (body['acl.geoUpdateInterval'] || '').trim() : '',
        },
        aclRules,
        useTlsFiles: parseBool(body, 'useTlsFiles', false),
    };
}

function isValidPortList(raw) {
    const value = String(raw || '').trim().toLowerCase();
    if (!value) return false;
    if (value === 'all') return true;

    const parts = value.split(',').map(p => p.trim()).filter(Boolean);
    if (parts.length === 0) return false;

    for (const part of parts) {
        if (/^\d+$/.test(part)) {
            const port = Number(part);
            if (!Number.isInteger(port) || port < 1 || port > 65535) return false;
            continue;
        }

        const match = part.match(/^(\d+)-(\d+)$/);
        if (!match) return false;

        const start = Number(match[1]);
        const end = Number(match[2]);
        if (!Number.isInteger(start) || !Number.isInteger(end)) return false;
        if (start < 1 || start > 65535 || end < 1 || end > 65535 || start > end) return false;
    }

    return true;
}

function isValidBandwidth(raw) {
    const value = String(raw || '').trim().toLowerCase();
    if (!value) return true;
    if (value === '0' || value === '0.0') return true;
    const match = value.match(/^(\d+(\.\d+)?)\s*([a-z]+)$/);
    if (!match) return false;
    const unit = match[3];
    return ['b', 'bps', 'kbps', 'kb', 'k', 'mbps', 'mb', 'm', 'gbps', 'gb', 'g', 'tbps', 'tb', 't'].includes(unit);
}

function isPositiveInteger(value) {
    return Number.isInteger(value) && value > 0;
}

function validateHysteriaFormFields(fields) {
    if (fields.hopInterval) {
        const sec = parseDurationSeconds(fields.hopInterval);
        if (!Number.isFinite(sec) || sec <= 0) {
            return 'Invalid hopInterval format (example: 30s, 1m)';
        }
        if (sec < 5) {
            return 'Invalid hopInterval: must be at least 5s';
        }
    }

    const acmeType = (fields.acme?.type || '').trim();
    if (acmeType && !['http', 'tls', 'dns'].includes(acmeType)) {
        return 'Invalid ACME challenge type';
    }
    if (acmeType === 'dns' && fields.acmeDnsConfigValid === false) {
        return 'ACME DNS config must be a valid JSON object';
    }
    if (acmeType === 'dns' && !fields.acme?.dnsName) {
        return 'ACME DNS mode requires provider name (acme.dns.name)';
    }
    if (fields.acme?.httpAltPort && (fields.acme.httpAltPort < 1 || fields.acme.httpAltPort > 65535)) {
        return 'ACME HTTP altPort must be between 1 and 65535';
    }
    if (fields.acme?.tlsAltPort && (fields.acme.tlsAltPort < 1 || fields.acme.tlsAltPort > 65535)) {
        return 'ACME TLS altPort must be between 1 and 65535';
    }

    if (fields.acl?.enabled && fields.acl?.type === 'file' && !fields.acl?.file) {
        return 'ACL file mode requires acl.file path';
    }

    if (fields.bandwidth?.up && !isValidBandwidth(fields.bandwidth.up)) {
        return 'Invalid bandwidth.up format (example: 100 mbps)';
    }
    if (fields.bandwidth?.down && !isValidBandwidth(fields.bandwidth.down)) {
        return 'Invalid bandwidth.down format (example: 100 mbps)';
    }

    if (fields.udpIdleTimeout) {
        const sec = parseDurationSeconds(fields.udpIdleTimeout);
        if (!Number.isFinite(sec) || sec <= 0) {
            return 'Invalid udpIdleTimeout format (example: 60s, 1m)';
        }
    }

    if (fields.sniff?.enabled) {
        const sniffTimeout = parseDurationSeconds(fields.sniff?.timeout);
        if (!Number.isFinite(sniffTimeout) || sniffTimeout <= 0) {
            return 'Invalid sniff.timeout format (example: 2s, 1m)';
        }
        if (!isValidPortList(fields.sniff?.tcpPorts)) {
            return 'Invalid sniff.tcpPorts format (example: 80,443,8000-9000 or all)';
        }
        if (!isValidPortList(fields.sniff?.udpPorts)) {
            return 'Invalid sniff.udpPorts format (example: 443,80,53 or all)';
        }
    }

    const quic = fields.quic || {};
    if (quic.enabled) {
        if (!isPositiveInteger(quic.initStreamReceiveWindow)) return 'quic.initStreamReceiveWindow must be a positive integer';
        if (!isPositiveInteger(quic.maxStreamReceiveWindow)) return 'quic.maxStreamReceiveWindow must be a positive integer';
        if (!isPositiveInteger(quic.initConnReceiveWindow)) return 'quic.initConnReceiveWindow must be a positive integer';
        if (!isPositiveInteger(quic.maxConnReceiveWindow)) return 'quic.maxConnReceiveWindow must be a positive integer';
        if (!isPositiveInteger(quic.maxIncomingStreams)) return 'quic.maxIncomingStreams must be a positive integer';
        const quicIdle = parseDurationSeconds(quic.maxIdleTimeout);
        if (!Number.isFinite(quicIdle) || quicIdle <= 0) return 'Invalid quic.maxIdleTimeout format (example: 60s, 1m)';
        if (quic.maxStreamReceiveWindow < quic.initStreamReceiveWindow) return 'quic.maxStreamReceiveWindow must be >= quic.initStreamReceiveWindow';
        if (quic.maxConnReceiveWindow < quic.initConnReceiveWindow) return 'quic.maxConnReceiveWindow must be >= quic.initConnReceiveWindow';
    }

    if (fields.resolver?.enabled) {
        const resolverType = fields.resolver.type || 'udp';
        if (!['udp', 'tcp', 'tls', 'https'].includes(resolverType)) return 'Invalid resolver.type';
        let timeoutRaw = '';
        if (resolverType === 'udp') timeoutRaw = fields.resolver.udpTimeout;
        if (resolverType === 'tcp') timeoutRaw = fields.resolver.tcpTimeout;
        if (resolverType === 'tls') timeoutRaw = fields.resolver.tlsTimeout;
        if (resolverType === 'https') timeoutRaw = fields.resolver.httpsTimeout;
        const timeoutSec = parseDurationSeconds(timeoutRaw);
        if (!Number.isFinite(timeoutSec) || timeoutSec <= 0) return `Invalid resolver.${resolverType}.timeout format`;
    }

    if (fields.masquerade?.type === 'string') {
        const sc = Number(fields.masquerade?.string?.statusCode);
        if (!Number.isFinite(sc) || sc < 100 || sc > 599) return 'Masquerade string statusCode must be between 100 and 599';
    } else {
        const proxyUrl = fields.masquerade?.proxy?.url || '';
        try {
            const parsed = new URL(proxyUrl);
            if (!['http:', 'https:'].includes(parsed.protocol)) return 'Masquerade proxy.url must use http:// or https://';
        } catch (_) {
            return 'Masquerade proxy.url is not a valid URL';
        }
    }

    return '';
}

// ─── IP Whitelist ────────────────────────────────────────────────────────────

function parseIpWhitelist() {
    const whitelist = config.PANEL_IP_WHITELIST || '';
    if (!whitelist.trim()) return null;
    return whitelist.split(',').map(ip => ip.trim()).filter(Boolean);
}

function isIpAllowed(clientIp, whitelist) {
    if (!whitelist || whitelist.length === 0) return true;
    const normalizedIp = clientIp.replace(/^::ffff:/, '');
    for (const entry of whitelist) {
        if (entry.includes('/')) {
            if (isIpInCidr(normalizedIp, entry)) return true;
        } else {
            if (normalizedIp === entry) return true;
        }
    }
    return false;
}

function isIpInCidr(ip, cidr) {
    const [range, bits] = cidr.split('/');
    const mask = parseInt(bits);
    const ipNum = ipToNum(ip);
    const rangeNum = ipToNum(range);
    if (ipNum === null || rangeNum === null) return false;
    const maskBits = ~((1 << (32 - mask)) - 1);
    return (ipNum & maskBits) === (rangeNum & maskBits);
}

function ipToNum(ip) {
    const parts = ip.split('.');
    if (parts.length !== 4) return null;
    return parts.reduce((acc, part) => (acc << 8) + parseInt(part), 0) >>> 0;
}

const checkIpWhitelist = (req, res, next) => {
    const whitelist = parseIpWhitelist();
    if (!whitelist) return next();
    const forwardedFor = req.headers['x-forwarded-for'];
    const clientIp = forwardedFor
        ? forwardedFor.split(',')[0].trim()
        : (req.ip || req.connection.remoteAddress || '');
    if (!isIpAllowed(clientIp, whitelist)) {
        logger.warn(`[Panel] Access denied for IP: ${clientIp}`);
        return res.status(403).send('Access denied. Your IP is not whitelisted.');
    }
    next();
};

// ─── Auth Middleware ──────────────────────────────────────────────────────────

const requireAuth = (req, res, next) => {
    if (!req.session || !req.session.authenticated) {
        return res.redirect('/panel/login');
    }
    next();
};

// ─── Render Engine ───────────────────────────────────────────────────────────

const render = (res, template, data = {}) => {
    const isProduction = process.env.NODE_ENV === 'production';
    let compiledTemplate = templateCache.get(template);

    if (!compiledTemplate || !isProduction) {
        const templatePath = path.join(__dirname, '../../../views', template + '.ejs');
        const templateContent = fs.readFileSync(templatePath, 'utf8');
        compiledTemplate = ejs.compile(templateContent, { filename: templatePath });
        if (isProduction) {
            templateCache.set(template, compiledTemplate);
        }
    }

    const i18nVars = {
        t: res.locals.t,
        lang: res.locals.lang,
        supportedLangs: res.locals.supportedLangs,
        locales: res.locals.locales,
    };

    const content = compiledTemplate({
        ...data,
        ...i18nVars,
        baseUrl: config.BASE_URL,
        config
    });

    res.render('layout', {
        ...data,
        ...i18nVars,
        content,
        baseUrl: config.BASE_URL,
        config,
    });
};

// ─── TOTP Shared Utilities ───────────────────────────────────────────────────

const PANEL_TOTP_PENDING_TTL_MS = 10 * 60 * 1000;
const SETTINGS_TOTP_ACTIONS = new Set([
    'password_change',
    'totp_enable_enroll',
    'totp_rotate_verify_current',
    'totp_rotate_enroll',
    'totp_disable_verify_current',
]);

function clearPanelTotpPending(req) {
    if (req.session) delete req.session.panelTotpPending;
}

function clearPanelLoginTotpLockout(req) {
    if (req.session) delete req.session.panelLoginTotpLockout;
}

function normalizePanelLoginTotpLockoutTime(resetTime) {
    if (!resetTime) return null;
    if (resetTime instanceof Date) {
        const value = resetTime.getTime();
        return Number.isFinite(value) ? value : null;
    }
    const value = Number(resetTime);
    return Number.isFinite(value) ? value : null;
}

function setPanelLoginTotpLockout(req, resetTime) {
    if (!req.session) return null;
    const blockedUntil = normalizePanelLoginTotpLockoutTime(resetTime);
    if (!blockedUntil || blockedUntil <= Date.now()) {
        clearPanelLoginTotpLockout(req);
        return null;
    }
    req.session.panelLoginTotpLockout = { blockedUntil };
    return req.session.panelLoginTotpLockout;
}

function getPanelLoginTotpLockout(req) {
    const lockout = req.session?.panelLoginTotpLockout;
    if (!lockout || typeof lockout !== 'object') return null;
    const blockedUntil = Number(lockout.blockedUntil);
    if (!Number.isFinite(blockedUntil)) {
        clearPanelLoginTotpLockout(req);
        return null;
    }
    if (blockedUntil <= Date.now()) {
        clearPanelLoginTotpLockout(req);
        return null;
    }
    return { blockedUntil };
}

function renderPanelLoginPage(req, res, { error = null, status = 200 } = {}) {
    const lockout = getPanelLoginTotpLockout(req);
    const t = typeof res.locals.t === 'function' ? res.locals.t : null;
    return res.status(status).render('login', {
        error,
        lockoutActive: Boolean(lockout),
        lockoutUntil: lockout?.blockedUntil || null,
        lockoutIso: lockout ? new Date(lockout.blockedUntil).toISOString() : null,
        lockoutReason: lockout ? (t ? t('auth.totpLoginLockoutMessage') : 'Login is temporarily blocked due to too many invalid verification attempts.') : null,
    });
}

function getPanelTotpPending(req, { clearInvalid = true } = {}) {
    const pending = req.session?.panelTotpPending;
    if (!pending || typeof pending !== 'object') return null;

    const invalidate = () => {
        if (clearInvalid) clearPanelTotpPending(req);
        return null;
    };

    if (!pending.type || !pending.createdAt || (Date.now() - pending.createdAt) >= PANEL_TOTP_PENDING_TTL_MS) return invalidate();
    if (!pending.username || typeof pending.username !== 'string') return invalidate();

    if (pending.type === 'setup') {
        if (!pending.passwordHash || !pending.secretEncrypted) return invalidate();
        return pending;
    }
    if (pending.type === 'login') {
        if (!pending.secretEncrypted) return invalidate();
        return pending;
    }
    if (pending.type !== 'settings') return invalidate();

    if (!pending.action || !SETTINGS_TOTP_ACTIONS.has(pending.action)) return invalidate();
    if (!req.session?.authenticated || req.session.adminUsername !== pending.username) return invalidate();
    if (!pending.returnTo || typeof pending.returnTo !== 'string') return invalidate();

    if (pending.action === 'password_change' && !pending.payload?.newPasswordHash) return invalidate();
    if ((pending.action === 'totp_rotate_verify_current' || pending.action === 'totp_disable_verify_current') && !pending.payload?.currentSecretEncrypted) return invalidate();
    if ((pending.action === 'totp_enable_enroll' || pending.action === 'totp_rotate_enroll') && !pending.secretEncrypted) return invalidate();

    return pending;
}

async function renderPanelTotpPage(res, pending, error = null) {
    const t = typeof res.locals.t === 'function' ? res.locals.t : null;

    if (pending.type === 'login') {
        return res.render('totp-verify', {
            mode: 'login', error,
            formAction: '/panel/totp',
            title: t ? t('auth.totpTitle') : 'Two-factor verification',
            description: t ? t('auth.totpLoginDescription') : 'Enter the code from your authenticator app to finish login.',
            buttonText: t ? t('auth.totpVerifyButton') : 'Verify',
        });
    }

    if (pending.type === 'setup') {
        const secret = totpService.decryptSecret(pending.secretEncrypted);
        const otpauthUrl = totpService.buildOtpAuthUrl({ secret, username: pending.username });
        const qrDataUrl = await totpService.generateQrDataUrl(otpauthUrl);
        return res.render('totp-verify', {
            mode: 'setup', error,
            formAction: '/panel/totp',
            title: t ? t('auth.totpSetupTitle') : 'Set up two-factor authentication',
            description: t ? t('auth.totpSetupDescription') : 'Scan the QR code and enter the 6-digit code from your authenticator app.',
            buttonText: t ? t('auth.totpVerifyButton') : 'Verify',
            username: pending.username, secret, qrDataUrl, showEnrollment: true,
        });
    }

    const isEnrollment = pending.action === 'totp_enable_enroll' || pending.action === 'totp_rotate_enroll';
    const titleByAction = {
        password_change: t ? t('auth.totpPasswordChangeTitle') : 'Confirm password change',
        totp_disable_verify_current: t ? t('auth.totpDisableTitle') : 'Confirm TOTP disable',
        totp_rotate_verify_current: t ? t('auth.totpRotateCurrentTitle') : 'Confirm current TOTP code',
        totp_enable_enroll: t ? t('auth.totpSettingsTitle') : 'Confirm TOTP setup',
        totp_rotate_enroll: t ? t('auth.totpSettingsTitle') : 'Confirm TOTP setup',
    };
    const descriptionByAction = {
        password_change: t ? t('auth.totpPasswordChangeDescription') : 'Enter your current TOTP code to apply the new password.',
        totp_disable_verify_current: t ? t('auth.totpDisableDescription') : 'Enter your current TOTP code to disable two-factor authentication.',
        totp_rotate_verify_current: t ? t('auth.totpRotateCurrentDescription') : 'Enter your current TOTP code to continue secret rotation.',
        totp_enable_enroll: t ? t('settings.totpEnableVerifyDescription') : 'Scan the QR code and enter the code from your authenticator app to finish enabling TOTP.',
        totp_rotate_enroll: t ? t('settings.totpRotateVerifyDescription') : 'Scan the new QR code and enter the code from your new device to complete secret rotation.',
    };
    const buttonByAction = {
        password_change: t ? t('auth.totpApplyPasswordButton') : 'Apply password change',
        totp_disable_verify_current: t ? t('auth.totpDisableButton') : 'Disable TOTP',
        totp_rotate_verify_current: t ? t('auth.totpContinueButton') : 'Continue',
        totp_enable_enroll: t ? t('auth.totpVerifyButton') : 'Verify',
        totp_rotate_enroll: t ? t('auth.totpVerifyButton') : 'Verify',
    };

    const payload = {
        mode: 'settings', error,
        formAction: '/panel/totp',
        title: titleByAction[pending.action] || (t ? t('auth.totpSettingsTitle') : 'Confirm TOTP setup'),
        description: descriptionByAction[pending.action] || (t ? t('auth.totpSetupDescription') : 'Scan the QR code and enter the 6-digit code from your authenticator app.'),
        buttonText: buttonByAction[pending.action] || (t ? t('auth.totpVerifyButton') : 'Verify'),
        cancelHref: pending.returnTo,
        showEnrollment: isEnrollment,
        username: pending.username,
    };

    if (!isEnrollment) return res.render('totp-verify', payload);

    const secret = totpService.decryptSecret(pending.secretEncrypted);
    const otpauthUrl = totpService.buildOtpAuthUrl({ secret, username: pending.username });
    const qrDataUrl = await totpService.generateQrDataUrl(otpauthUrl);

    return res.render('totp-verify', { ...payload, secret, qrDataUrl });
}

function redirectSettingsSecurity(res, { message = null, error = null } = {}) {
    const params = new URLSearchParams({ tab: 'security' });
    if (message) params.set('message', message);
    if (error) params.set('error', error);
    return res.redirect(`/panel/settings?${params.toString()}`);
}

// ─── Rate Limiters ───────────────────────────────────────────────────────────

const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 5,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req, res) => {
        logger.warn(`[Panel] Rate limit exceeded for IP: ${req.ip}`);
        const lockout = getPanelLoginTotpLockout(req);
        if (lockout) return renderPanelLoginPage(req, res, { status: 429 });
        const message = res.locals.t?.('auth.tooManyAttempts') || 'Too many login attempts. Try again in 15 minutes.';
        return renderPanelLoginPage(req, res, { error: message, status: 429 });
    },
});

const totpVerifyLimiter = rateLimit({
    windowMs: 10 * 60 * 1000,
    max: 8,
    standardHeaders: true,
    legacyHeaders: false,
    handler: async (req, res) => {
        logger.warn(`[Panel] TOTP verify rate limit exceeded (IP: ${req.ip})`);
        const message = res.locals.t?.('auth.tooManyTotpAttempts') || 'Too many verification attempts. Try again later.';
        const pending = getPanelTotpPending(req, { clearInvalid: false });
        if (pending?.type === 'login') {
            setPanelLoginTotpLockout(req, req.rateLimit?.resetTime);
            clearPanelTotpPending(req);
            return res.redirect('/panel/login');
        }
        if (pending?.type === 'settings') return redirectSettingsSecurity(res, { error: message });
        if (pending) return renderPanelTotpPage(res, pending, message);
        if (req.session?.authenticated) return redirectSettingsSecurity(res, { error: message });
        return res.redirect('/panel/login');
    },
});

const generateSshKeyLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 3,
    standardHeaders: true,
    legacyHeaders: false,
});

const sniScanLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 5,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req, res) => {
        res.status(429).json({ error: 'Too many scan requests. Try again in a minute.' });
    },
});

module.exports = {
    backupUpload,
    buildSshKeyFilename,
    connectNodeSSH,
    parseXrayFormFields,
    parseBool,
    parseHeaderMap,
    parseHysteriaFormFields,
    getHysteriaAclInlineState,
    validateHysteriaFormFields,
    checkIpWhitelist,
    requireAuth,
    render,
    loginLimiter,
    totpVerifyLimiter,
    generateSshKeyLimiter,
    sniScanLimiter,
    clearPanelTotpPending,
    clearPanelLoginTotpLockout,
    setPanelLoginTotpLockout,
    getPanelLoginTotpLockout,
    renderPanelLoginPage,
    getPanelTotpPending,
    renderPanelTotpPage,
    redirectSettingsSecurity,
    SETTINGS_TOTP_ACTIONS,
};
