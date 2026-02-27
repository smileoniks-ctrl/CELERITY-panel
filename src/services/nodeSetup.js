/**
 * Hysteria node auto-setup service via SSH
 */

const { Client } = require('ssh2');
const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');
const config = require('../../config');
const cryptoService = require('./cryptoService');
const Settings = require('../models/settingsModel');
const configGenerator = require('./configGenerator');

/**
 * Read panel's SSL certificates from Greenlock directory
 * @param {string} domain - Panel domain
 * @returns {Object|null} { cert, key } or null if not found
 */
function getPanelCertificates(domain) {
    try {
        // Greenlock stores certificates in greenlock.d/live/{domain}/
        const greenlockDir = path.join(__dirname, '../../greenlock.d/live', domain);
        
        const certPath = path.join(greenlockDir, 'cert.pem');
        const keyPath = path.join(greenlockDir, 'privkey.pem');
        
        // Also try fullchain.pem if cert.pem doesn't exist
        const fullchainPath = path.join(greenlockDir, 'fullchain.pem');
        
        let cert, key;
        
        if (fs.existsSync(certPath)) {
            cert = fs.readFileSync(certPath, 'utf8');
        } else if (fs.existsSync(fullchainPath)) {
            cert = fs.readFileSync(fullchainPath, 'utf8');
        }
        
        if (fs.existsSync(keyPath)) {
            key = fs.readFileSync(keyPath, 'utf8');
        }
        
        if (cert && key) {
            logger.info(`[NodeSetup] Found panel certificates for ${domain}`);
            return { cert, key };
        }
        
        logger.warn(`[NodeSetup] Panel certificates not found in ${greenlockDir}`);
        return null;
        
    } catch (error) {
        logger.error(`[NodeSetup] Error reading panel certificates: ${error.message}`);
        return null;
    }
}

const INSTALL_SCRIPT = `#!/bin/bash
set -e

echo "=== [1/5] Checking Hysteria installation ==="

if ! command -v hysteria &> /dev/null; then
    echo "Hysteria not found. Installing..."
    bash <(curl -fsSL https://get.hy2.sh/)
    echo "Done: Hysteria installed"
else
    echo "Done: Hysteria already installed"
fi

mkdir -p /etc/hysteria
echo "Done: Directory /etc/hysteria ready"

echo "Hysteria version:"
hysteria version
`;

function getPortHoppingScript(portRange, mainPort) {
    if (!portRange || !portRange.includes('-')) return '';
    
    const [start, end] = portRange.split('-').map(p => parseInt(p.trim()));
    
    return `
echo "=== [4/5] Setting up port hopping ${start}-${end} -> ${mainPort} ==="

# Clear old rules
iptables -t nat -D PREROUTING -p udp --dport ${start}:${end} -j REDIRECT --to-port ${mainPort} 2>/dev/null || true
ip6tables -t nat -D PREROUTING -p udp --dport ${start}:${end} -j REDIRECT --to-port ${mainPort} 2>/dev/null || true

# Clear legacy interface-specific rules
for iface in eth0 eth1 ens3 ens5 enp0s3 eno1; do
    iptables -t nat -D PREROUTING -i $iface -p udp --dport ${start}:${end} -j REDIRECT --to-port ${mainPort} 2>/dev/null || true
    ip6tables -t nat -D PREROUTING -i $iface -p udp --dport ${start}:${end} -j REDIRECT --to-port ${mainPort} 2>/dev/null || true
done

# Add new rules (no interface binding)
iptables -t nat -A PREROUTING -p udp --dport ${start}:${end} -j REDIRECT --to-port ${mainPort}
ip6tables -t nat -A PREROUTING -p udp --dport ${start}:${end} -j REDIRECT --to-port ${mainPort}
echo "Done: iptables NAT rules added"

# Open ports in firewall (ufw)
if command -v ufw &> /dev/null && ufw status 2>/dev/null | grep -q "Status: active"; then
    ufw allow ${start}:${end}/udp 2>/dev/null || true
    echo "Done: UFW rules added"
fi

# Save rules
if command -v netfilter-persistent &> /dev/null; then
    netfilter-persistent save 2>/dev/null
    echo "Done: Rules saved with netfilter-persistent"
elif [ -f /etc/debian_version ]; then
    apt-get install -y iptables-persistent 2>/dev/null || true
    netfilter-persistent save 2>/dev/null || true
elif command -v iptables-save &> /dev/null; then
    mkdir -p /etc/iptables
    iptables-save > /etc/iptables/rules.v4 2>/dev/null || true
    ip6tables-save > /etc/iptables/rules.v6 2>/dev/null || true
    echo "Done: Rules saved with iptables-save"
fi

echo "Done: Port hopping configured: ${start}-${end} -> ${mainPort}"
`;
}

const SELF_SIGNED_CERT_SCRIPT = `
echo "=== [2/5] Generating self-signed certificate ==="

if ! command -v openssl &> /dev/null; then
    echo "Installing openssl..."
    apt-get update && apt-get install -y openssl
fi

echo "Checking existing certificates..."
ls -la /etc/hysteria/*.pem 2>/dev/null || echo "No existing cert files"

CERT_VALID=0
if [ -f /etc/hysteria/cert.pem ] && [ -s /etc/hysteria/cert.pem ] && [ -f /etc/hysteria/key.pem ] && [ -s /etc/hysteria/key.pem ]; then
    if openssl x509 -in /etc/hysteria/cert.pem -noout 2>/dev/null; then
        echo "Done: Valid certificate already exists"
        CERT_VALID=1
        openssl x509 -in /etc/hysteria/cert.pem -noout -subject -dates
    else
        echo "Warning: Certificate file exists but is invalid, regenerating..."
    fi
fi

if [ "$CERT_VALID" = "0" ]; then
    echo "Generating new certificate..."
    
    rm -f /etc/hysteria/cert.pem /etc/hysteria/key.pem /tmp/ecparam.pem
    mkdir -p /etc/hysteria
    
    echo "Step 1: Generating EC parameters..."
    openssl ecparam -name prime256v1 -out /tmp/ecparam.pem
    if [ ! -f /tmp/ecparam.pem ]; then
        echo "Error: Failed to create EC parameters"
        exit 1
    fi
    echo "Done: EC parameters created"
    
    echo "Step 2: Generating certificate..."
    openssl req -x509 -nodes -newkey ec:/tmp/ecparam.pem \\
        -keyout /etc/hysteria/key.pem \\
        -out /etc/hysteria/cert.pem \\
        -subj "/CN=bing.com" \\
        -days 36500 2>&1
    
    if [ ! -f /etc/hysteria/cert.pem ] || [ ! -s /etc/hysteria/cert.pem ]; then
        echo "Error: Certificate file not created or empty!"
        echo "Trying alternative method with RSA..."
        
        openssl req -x509 -nodes -newkey rsa:2048 \\
            -keyout /etc/hysteria/key.pem \\
            -out /etc/hysteria/cert.pem \\
            -subj "/CN=bing.com" \\
            -days 36500 2>&1
    fi
    
    if [ ! -f /etc/hysteria/key.pem ] || [ ! -s /etc/hysteria/key.pem ]; then
        echo "Error: Key file not created or empty!"
        exit 1
    fi
    
    # Set correct ownership for hysteria user (if exists)
    if id "hysteria" &>/dev/null; then
        chown hysteria:hysteria /etc/hysteria/key.pem /etc/hysteria/cert.pem
        echo "Done: Ownership set to hysteria:hysteria"
    fi
    chmod 600 /etc/hysteria/key.pem
    chmod 644 /etc/hysteria/cert.pem
    rm -f /tmp/ecparam.pem
    
    echo "Step 3: Verifying certificate..."
    if openssl x509 -in /etc/hysteria/cert.pem -noout 2>/dev/null; then
        echo "Done: Certificate generated successfully!"
        openssl x509 -in /etc/hysteria/cert.pem -noout -subject -dates
        ls -la /etc/hysteria/*.pem
    else
        echo "Error: Certificate verification failed!"
        cat /etc/hysteria/cert.pem
        exit 1
    fi
fi
`;

function connectSSH(node) {
    return new Promise((resolve, reject) => {
        const conn = new Client();
        
        const connConfig = {
            host: node.ip,
            port: node.ssh?.port || 22,
            username: node.ssh?.username || 'root',
            readyTimeout: 30000,
        };
        
        if (node.ssh?.privateKey) {
            connConfig.privateKey = node.ssh.privateKey;
        } else if (node.ssh?.password) {
            connConfig.password = cryptoService.decrypt(node.ssh.password);
        } else {
            return reject(new Error('SSH credentials not provided'));
        }
        
        conn.on('ready', () => resolve(conn));
        conn.on('error', (err) => reject(err));
        conn.connect(connConfig);
    });
}

function execSSH(conn, command) {
    return new Promise((resolve, reject) => {
        conn.exec(command, (err, stream) => {
            if (err) return reject(err);
            
            let stdout = '';
            let stderr = '';
            
            stream.on('close', (code) => {
                const output = stdout + (stderr ? '\n[STDERR]:\n' + stderr : '');
                
                if (code === 0) {
                    resolve({ success: true, output, code });
                } else {
                    resolve({ success: false, output, code, error: `Exit code: ${code}` });
                }
            });
            
            stream.on('data', (data) => { stdout += data.toString(); });
            stream.stderr.on('data', (data) => { stderr += data.toString(); });
        });
    });
}

function uploadFile(conn, content, remotePath) {
    return new Promise((resolve, reject) => {
        conn.sftp((err, sftp) => {
            if (err) return reject(err);
            
            const writeStream = sftp.createWriteStream(remotePath);
            writeStream.on('close', () => resolve());
            writeStream.on('error', (err) => reject(err));
            writeStream.write(content);
            writeStream.end();
        });
    });
}

async function setupNode(node, options = {}) {
    const { installHysteria = true, setupPortHopping = true, restartService = true } = options;
    
    const logs = [];
    const log = (msg) => {
        const line = `[${new Date().toISOString()}] ${msg}`;
        logs.push(line);
        logger.info(`[NodeSetup] ${msg}`);
    };
    
    log(`Starting setup for ${node.name} (${node.ip})`);
    
    // Get settings for auth insecure option
    const settings = await Settings.get();
    const authInsecure = settings?.nodeAuth?.insecure ?? true;
    
    const authUrl = `${config.BASE_URL}/api/auth`;
    log(`Auth URL: ${authUrl} (insecure: ${authInsecure})`);
    
    let conn;
    
    try {
        log('Connecting via SSH...');
        conn = await connectSSH(node);
        log('SSH connected');
        
        if (installHysteria) {
            log('Installing Hysteria...');
            const installResult = await execSSH(conn, INSTALL_SCRIPT);
            logs.push(installResult.output);
            
            if (!installResult.success) {
                throw new Error(`Hysteria installation failed: ${installResult.error}`);
            }
            log('Hysteria installed');
        }
        
        // Determine TLS mode: same-VPS (copy panel certs), ACME, or self-signed
        const isSameVpsSetup = node.domain && node.domain === config.PANEL_DOMAIN;
        let useTlsFiles = false;
        
        if (!node.domain) {
            // No domain - use self-signed certificate
            log('No domain specified, generating self-signed certificate...');
            const certResult = await execSSH(conn, SELF_SIGNED_CERT_SCRIPT);
            logs.push(certResult.output);
            
            if (!certResult.success) {
                throw new Error(`Certificate generation failed: ${certResult.error}`);
            }
            log('Certificate ready (self-signed)');
            useTlsFiles = true;
            
        } else if (isSameVpsSetup) {
            // Same domain as panel - copy panel's certificates to node
            log(`Same-VPS setup detected (domain: ${node.domain})`);
            log('Copying panel certificates to node...');
            
            const panelCerts = getPanelCertificates(config.PANEL_DOMAIN);
            
            if (panelCerts) {
                // Upload certificates to node
                await uploadFile(conn, panelCerts.cert, '/etc/hysteria/cert.pem');
                await uploadFile(conn, panelCerts.key, '/etc/hysteria/key.pem');
                
                // Set correct permissions
                await execSSH(conn, `
chmod 644 /etc/hysteria/cert.pem
chmod 600 /etc/hysteria/key.pem
if id "hysteria" &>/dev/null; then
    chown hysteria:hysteria /etc/hysteria/cert.pem /etc/hysteria/key.pem
fi
echo "Done: Panel certificates copied to node"
ls -la /etc/hysteria/*.pem
                `);
                
                log('Panel certificates copied successfully');
                useTlsFiles = true;
            } else {
                log('Warning: Could not read panel certificates, falling back to self-signed');
                const certResult = await execSSH(conn, SELF_SIGNED_CERT_SCRIPT);
                logs.push(certResult.output);
                useTlsFiles = true;
            }
            
        } else {
            // Different domain - use ACME (but warn about potential port 80 conflict)
            log(`Domain detected (${node.domain}), ACME will be used`);
            log('⚠️  WARNING: If this node is on the same VPS as the panel, ACME may fail!');
            log('⚠️  Port 80 is used by the panel for its own ACME challenges.');
            log('⚠️  Consider using the panel domain or no domain (self-signed) for same-VPS setup.');
            log('Opening port 80 for ACME HTTP-01 challenge...');
            
            const acmeSetup = await execSSH(conn, `
echo "=== Setting up for ACME ==="

mkdir -p /etc/hysteria/acme
chmod 777 /etc/hysteria/acme
chmod 755 /etc/hysteria
echo "Done: ACME directory created with correct permissions"

ls -la /etc/hysteria/

if command -v iptables &> /dev/null; then
    iptables -I INPUT -p tcp --dport 80 -j ACCEPT 2>/dev/null || true
    iptables -I INPUT -p udp --dport 80 -j ACCEPT 2>/dev/null || true
    echo "Done: Port 80 opened in iptables"
fi

if command -v ufw &> /dev/null && ufw status | grep -q "active"; then
    ufw allow 80/tcp 2>/dev/null || true
    ufw allow 80/udp 2>/dev/null || true
    echo "Done: Port 80 opened in ufw"
fi

if ss -tlnp | grep -q ':80 '; then
    echo "⚠️  Warning: Port 80 is already in use (likely by the panel):"
    ss -tlnp | grep ':80 '
    echo "ACME challenge will likely fail if panel is on the same server!"
else
    echo "Done: Port 80 is free"
fi

echo "Done: ACME preparation complete"
echo "Note: Make sure DNS for ${node.domain} points to this server's IP!"
            `);
            logs.push(acmeSetup.output);
            log('ACME preparation done');
        }
        
        log('Uploading config...');
        const hysteriaConfig = configGenerator.generateNodeConfig(node, authUrl, { authInsecure, useTlsFiles });
        await uploadFile(conn, hysteriaConfig, '/etc/hysteria/config.yaml');
        log('Config uploaded to /etc/hysteria/config.yaml');
        logs.push('--- Config content ---');
        logs.push(hysteriaConfig);
        logs.push('--- End config ---');
        
        if (setupPortHopping && node.portRange) {
            log(`Setting up port hopping (${node.portRange})...`);
            const portHoppingScript = getPortHoppingScript(node.portRange, node.port || 443);
            if (portHoppingScript) {
                const hopResult = await execSSH(conn, portHoppingScript);
                logs.push(hopResult.output);
                
                if (!hopResult.success) {
                    log(`Port hopping setup warning: ${hopResult.error}`);
                } else {
                    log('Port hopping configured');
                }
            }
        }
        
        const statsPort = node.statsPort || 9999;
        const mainPort = node.port || 443;
        log(`Opening firewall ports (${mainPort}, ${statsPort})...`);
        const firewallResult = await execSSH(conn, `
echo "=== [5/6] Opening firewall ports ==="

if command -v iptables &> /dev/null; then
    iptables -I INPUT -p tcp --dport ${mainPort} -j ACCEPT 2>/dev/null || true
    iptables -I INPUT -p udp --dport ${mainPort} -j ACCEPT 2>/dev/null || true
    iptables -I INPUT -p tcp --dport ${statsPort} -j ACCEPT 2>/dev/null || true
    echo "Done: Ports ${mainPort}, ${statsPort} opened in iptables"
fi

if command -v ufw &> /dev/null && ufw status | grep -q "active"; then
    ufw allow ${mainPort}/tcp 2>/dev/null || true
    ufw allow ${mainPort}/udp 2>/dev/null || true
    ufw allow ${statsPort}/tcp 2>/dev/null || true
    echo "Done: Ports ${mainPort}, ${statsPort} opened in ufw"
fi

echo "Done: Firewall configured"
        `);
        logs.push(firewallResult.output);
        log('Firewall ports opened');
        
        if (restartService) {
            log('Restarting Hysteria service...');
            const restartResult = await execSSH(conn, `
echo "=== [6/6] Restarting Hysteria service ==="
systemctl enable hysteria-server 2>/dev/null || true
systemctl restart hysteria-server
sleep 3
echo "Service status:"
systemctl status hysteria-server --no-pager -l || true
echo ""
echo "Journal logs (last 20 lines):"
journalctl -u hysteria-server -n 20 --no-pager || true
            `);
            logs.push(restartResult.output);
            
            if (!restartResult.success) {
                log(`Service restart warning: ${restartResult.error}`);
            } else {
                log('Service restarted');
            }
        }
        
        log('Setup completed successfully!');
        return { success: true, logs };
        
    } catch (error) {
        log(`Error: ${error.message}`);
        return { success: false, error: error.message, logs };
        
    } finally {
        if (conn) {
            conn.end();
        }
    }
}

async function checkNodeStatus(node) {
    try {
        const conn = await connectSSH(node);
        
        try {
            const result = await execSSH(conn, 'systemctl is-active hysteria-server');
            return result.output.trim() === 'active' ? 'online' : 'offline';
        } finally {
            conn.end();
        }
    } catch (error) {
        return 'error';
    }
}

async function getNodeLogs(node, lines = 50) {
    try {
        const conn = await connectSSH(node);
        
        try {
            const result = await execSSH(conn, `journalctl -u hysteria-server -n ${lines} --no-pager`);
            return { success: true, logs: result.output };
        } finally {
            conn.end();
        }
    } catch (error) {
        return { success: false, error: error.message };
    }
}

module.exports = {
    setupNode,
    checkNodeStatus,
    getNodeLogs,
    connectSSH,
    execSSH,
    uploadFile,
};
