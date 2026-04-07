/**
 * Test subscription endpoint with different User-Agents.
 * Usage: node test-subscription.js <subscription-url>
 * Example: node test-subscription.js https://test.click-net.one/api/files/21197d518ab9f7b5
 */

const https = require('https');
const http = require('http');

const SUB_URL = process.argv[2];
if (!SUB_URL) {
    console.error('Usage: node test-subscription.js <subscription-url>');
    process.exit(1);
}

const USER_AGENTS = {
    'HAPP':          'Happ/2.5.0',
    'Streisand':     'Streisand/2.1.0',
    'Hiddify':       'HiddifyNext/4.0.5 (android) like ClashMeta v2ray sing-box',
    'v2rayNG':       'v2rayNG/1.8.19',
    'v2rayN (CC)':   'v2rayN/6.60',
    'Clash Meta':    'ClashMeta/1.18',
    'Stash':         'Stash/2.7.0',
    'Shadowrocket':  'Shadowrocket/1940 CFNetwork/1496.0.7 Darwin/23.5.0',
    'SFA':           'SFA/1.8.0',
    'NekoBox':       'NekoBox/1.3.0',
    'No UA':         '',
    'curl':          'curl/8.5.0',
    '?format=uri':          '__FORMAT_OVERRIDE__',
    '?format=singbox':      '__FORMAT_OVERRIDE__',
    '?format=clash':        '__FORMAT_OVERRIDE__',
    '?format=v2ray-json':   '__FORMAT_OVERRIDE__',
};

function fetch(url, ua) {
    return new Promise((resolve, reject) => {
        const parsedUrl = new URL(url);
        const client = parsedUrl.protocol === 'https:' ? https : http;
        const opts = {
            hostname: parsedUrl.hostname,
            port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
            path: parsedUrl.pathname + parsedUrl.search,
            method: 'GET',
            headers: { 'User-Agent': ua },
            rejectUnauthorized: false,
            timeout: 10000,
        };
        const req = client.request(opts, (res) => {
            let body = '';
            res.on('data', d => body += d);
            res.on('end', () => resolve({
                status: res.statusCode,
                headers: res.headers,
                body,
            }));
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
        req.end();
    });
}

function truncate(s, max = 200) {
    s = s.replace(/\n/g, '\\n');
    return s.length > max ? s.slice(0, max) + '...' : s;
}

function detectType(body, ct) {
    if (ct && ct.includes('text/html')) return 'HTML';
    const trimmed = body.trim();
    if (trimmed.startsWith('{')) {
        try {
            const j = JSON.parse(trimmed);
            if (j.outbounds)  return 'XRAY-JSON';
            if (j.inbounds)   return 'SINGBOX-JSON';
            return 'JSON';
        } catch { return 'INVALID-JSON'; }
    }
    if (trimmed.startsWith('proxies:')) return 'CLASH-YAML';
    const decoded = Buffer.from(trimmed, 'base64').toString();
    if (/^(vless|vmess|hysteria2|trojan|ss):\/\//m.test(decoded)) return 'BASE64-URI';
    if (/^(vless|vmess|hysteria2|trojan|ss):\/\//m.test(trimmed)) return 'PLAIN-URI';
    return 'UNKNOWN';
}

(async () => {
    const SEP = '─'.repeat(100);
    console.log(`\nTesting: ${SUB_URL}\n${SEP}`);

    for (const [label, ua] of Object.entries(USER_AGENTS)) {
        let url = SUB_URL;
        let actualUa = ua;

        if (ua === '__FORMAT_OVERRIDE__') {
            const fmt = label.match(/format=(\S+)/)?.[1];
            url = SUB_URL + (SUB_URL.includes('?') ? '&' : '?') + `format=${fmt}`;
            actualUa = 'curl/8.5.0';
        }

        try {
            const r = await fetch(url, actualUa);
            const ct = r.headers['content-type'] || '';
            const type = detectType(r.body, ct);
            const lines = r.body.trim().split('\n').length;
            const profTitle = r.headers['profile-title'] || '-';
            const provId = r.headers['providerid'] || '-';
            const subInfo = r.headers['subscription-userinfo'] || '-';
            const routingHdr = r.headers['routing'] || '';

            console.log(`\n[${label}]  UA: "${actualUa}"`);
            console.log(`  Status: ${r.status}  Content-Type: ${ct}`);
            console.log(`  Detected: ${type}  Lines: ${lines}  Size: ${r.body.length} bytes`);
            console.log(`  Profile-Title: ${profTitle}  ProviderID: ${provId}`);
            console.log(`  Sub-Userinfo: ${subInfo}`);
            if (routingHdr) {
                console.log(`  *** HAPP Routing header: ${routingHdr.substring(0, 40)}...`);
                try {
                    const b64 = routingHdr.split('/').pop();
                    const profile = JSON.parse(Buffer.from(b64, 'base64').toString());
                    console.log(`    Profile: "${profile.Name}" DirectSites=${(profile.DirectSites||[]).length} DirectIp=${(profile.DirectIp||[]).length} BlockSites=${(profile.BlockSites||[]).length}`);
                    console.log(`    DNS: remote=${profile.RemoteDNSType}/${profile.RemoteDNSIP} domestic=${profile.DomesticDNSType}/${profile.DomesticDNSIP}`);
                } catch (e) { console.log(`    (decode error: ${e.message})`); }
            }
            console.log(`  Body: ${truncate(r.body)}`);

            if (type === 'XRAY-JSON' || type === 'SINGBOX-JSON' || type === 'JSON') {
                try {
                    const j = JSON.parse(r.body);
                    const outs = j.outbounds || [];
                    console.log(`  Outbounds (${outs.length}): ${outs.map(o => `${o.tag || o.type}[${o.protocol || o.type}]`).join(', ')}`);
                    if (j.routing?.rules) console.log(`  Routing rules: ${j.routing.rules.length}`);
                    if (j.route?.rules)  console.log(`  Route rules: ${j.route.rules.length}`);
                    if (j.dns?.servers)  console.log(`  DNS servers: ${j.dns.servers.length}`);
                } catch {}
            }

            if (type === 'PLAIN-URI' || type === 'BASE64-URI') {
                const text = type === 'BASE64-URI' ? Buffer.from(r.body.trim(), 'base64').toString() : r.body;
                const uris = text.trim().split('\n').filter(l => l.trim());
                console.log(`  URIs (${uris.length}):`);
                uris.slice(0, 5).forEach(u => console.log(`    ${truncate(u, 120)}`));
                if (uris.length > 5) console.log(`    ... +${uris.length - 5} more`);
            }

            if (type === 'CLASH-YAML') {
                const hasRules = /^rules:/m.test(r.body);
                const hasDns = /^dns:/m.test(r.body);
                const proxies = (r.body.match(/- name: "/g) || []).length;
                console.log(`  Proxies: ${proxies}  Has rules: ${hasRules}  Has dns: ${hasDns}`);
            }
        } catch (err) {
            console.log(`\n[${label}]  UA: "${actualUa}"`);
            console.log(`  ERROR: ${err.message}`);
        }
    }

    console.log(`\n${SEP}\nDone.\n`);
})();
