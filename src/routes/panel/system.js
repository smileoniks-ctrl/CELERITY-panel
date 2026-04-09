/**
 * Panel routes: system stats, logs, backup/restore.
 */

const router = require('express').Router();
const os = require('os');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const { createReadStream } = require('fs');
const readline = require('readline');
const { promisify } = require('util');
const exec = promisify(require('child_process').exec);

const HyNode = require('../../models/hyNodeModel');
const cache = require('../../services/cacheService');
const rpsCounter = require('../../middleware/rpsCounter');
const config = require('../../../config');
const logger = require('../../utils/logger');
const { backupUpload } = require('./helpers');

// ─── Log Helpers ─────────────────────────────────────────────────────────────

async function getCombinedLogFiles(logsDir) {
    try {
        await fsp.access(logsDir);
    } catch {
        return [];
    }

    const dirEntries = await fsp.readdir(logsDir, { withFileTypes: true });
    const logEntries = dirEntries.filter(
        (entry) => entry.isFile() && entry.name.startsWith('combined') && entry.name.endsWith('.log')
    );

    const files = await Promise.all(
        logEntries.map(async (entry) => {
            const fullPath = path.join(logsDir, entry.name);
            const stat = await fsp.stat(fullPath);
            return {
                name: entry.name,
                path: fullPath,
                mtime: stat.mtime,
            };
        })
    );

    return files.sort((a, b) => b.mtime - a.mtime);
}

async function readLastLogLines(filePath, maxLines) {
    const tail = [];
    const rl = readline.createInterface({
        input: createReadStream(filePath, { encoding: 'utf8' }),
        crlfDelay: Infinity,
    });

    for await (const line of rl) {
        if (!line) continue;
        tail.push(line);
        if (tail.length > maxLines) {
            tail.shift();
        }
    }

    return tail.reverse();
}

// ─── CPU Sampler ──────────────────────────────────────────────────────────────

let _cpuPercent = 0;
let _prevCpuTimes = null;

function sampleCpuTimes() {
    const cpus = os.cpus();
    let idle = 0, total = 0;
    for (const cpu of cpus) {
        const t = cpu.times;
        idle += t.idle;
        total += t.user + t.nice + t.sys + t.idle + t.irq;
    }
    return { idle, total };
}

function updateCpuPercent() {
    const cur = sampleCpuTimes();
    if (_prevCpuTimes) {
        const dIdle = cur.idle - _prevCpuTimes.idle;
        const dTotal = cur.total - _prevCpuTimes.total;
        _cpuPercent = dTotal > 0 ? Math.min(Math.round((1 - dIdle / dTotal) * 100), 100) : 0;
    }
    _prevCpuTimes = cur;
}

_prevCpuTimes = sampleCpuTimes();
const _cpuInterval = setInterval(updateCpuPercent, 2000);
_cpuInterval.unref();

// ─── Routes ──────────────────────────────────────────────────────────────────

// GET /panel/system-stats
router.get('/system-stats', async (req, res) => {
    try {
        const cpus = os.cpus();
        const loadAvg = os.loadavg();
        const totalMem = os.totalmem();
        const freeMem = os.freemem();
        const usedMem = totalMem - freeMem;
        const processMemory = process.memoryUsage();

        const cpuPercent = _cpuPercent;

        const requestStats = rpsCounter.getStats();
        const rps = requestStats.rps;
        const rpm = requestStats.rpm;

        const cacheStats = await cache.getStats();

        const activeNodes = await HyNode.find({ active: true }).select('onlineUsers').lean();
        const totalConnections = activeNodes.reduce((sum, n) => sum + (n.onlineUsers || 0), 0);

        res.json({
            success: true,
            cpu: {
                cores: cpus.length,
                model: cpus[0]?.model || 'Unknown',
                percent: cpuPercent,
                load1: loadAvg[0],
                load5: loadAvg[1],
                load15: loadAvg[2],
            },
            mem: {
                total: totalMem,
                used: usedMem,
                free: freeMem,
                percent: Math.round((usedMem / totalMem) * 100),
            },
            process: {
                heapUsed: processMemory.heapUsed,
                heapTotal: processMemory.heapTotal,
                rss: processMemory.rss,
            },
            requests: {
                rps: rps,
                rpm: rpm,
            },
            connections: totalConnections,
            cache: cacheStats,
            uptime: Math.floor(process.uptime()),
            platform: os.platform(),
            nodeVersion: process.version,
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// GET /panel/logs
router.get('/logs', async (req, res) => {
    try {
        const logsDir = path.join(__dirname, '../../../logs');
        let logs = [];

        const files = await getCombinedLogFiles(logsDir);

        if (files.length > 0) {
            logs = await readLastLogLines(files[0].path, 100);
        }

        res.json({ logs });
    } catch (error) {
        logger.error(`[Panel] Logs read error: ${error.message}`);
        res.json({ logs: [], error: error.message });
    }
});

// GET /panel/logs/search
router.get('/logs/search', async (req, res) => {
    try {
        const q = (req.query.q || '').trim();
        const limit = Math.min(parseInt(req.query.limit) || 200, 500);

        if (!q) {
            return res.json({ matches: [], total: 0 });
        }

        const logsDir = path.join(__dirname, '../../../logs');
        const files = await getCombinedLogFiles(logsDir);

        const qLower = q.toLowerCase();
        const matches = [];
        let total = 0;

        for (const file of files) {
            const fileMatches = [];
            const rl = readline.createInterface({
                input: createReadStream(file.path, { encoding: 'utf8' }),
                crlfDelay: Infinity,
            });

            for await (const line of rl) {
                if (!line) continue;

                if (line.toLowerCase().includes(qLower)) {
                    total += 1;
                    fileMatches.push(line);

                    if (fileMatches.length > limit) {
                        fileMatches.shift();
                    }
                }
            }

            for (let i = fileMatches.length - 1; i >= 0 && matches.length < limit; i -= 1) {
                matches.push(fileMatches[i]);
            }
        }

        res.json({ matches, total });
    } catch (error) {
        logger.error(`[Panel] Logs search error: ${error.message}`);
        res.json({ matches: [], total: 0, error: error.message });
    }
});

// POST /panel/backup
router.post('/backup', async (req, res) => {
    try {
        const backupDir = path.join(__dirname, '../../../backups');
        if (!fs.existsSync(backupDir)) {
            fs.mkdirSync(backupDir, { recursive: true });
        }

        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const backupName = `hysteria-backup-${timestamp}`;
        const backupPath = path.join(backupDir, backupName);
        const archivePath = path.join(backupDir, `${backupName}.tar.gz`);

        const mongoUri = config.MONGO_URI;
        const dumpCmd = `mongodump --uri="${mongoUri}" --out="${backupPath}" --gzip`;

        await exec(dumpCmd);
        logger.info(`[Backup] Dump created: ${backupPath}`);

        const tarCmd = `cd "${backupDir}" && tar -czf "${backupName}.tar.gz" "${backupName}" && rm -rf "${backupName}"`;
        await exec(tarCmd);
        logger.info(`[Backup] Archive created: ${archivePath}`);

        res.download(archivePath, `${backupName}.tar.gz`, (err) => {
            if (err) {
                logger.error(`[Backup] Send error: ${err.message}`);
            }
        });
    } catch (error) {
        logger.error(`[Backup] Error: ${error.message}`);
        res.status(500).json({ error: error.message });
    }
});

// POST /panel/restore
router.post('/restore', backupUpload.single('backup'), async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'Файл backup не загружен' });
    }

    const uploadedFile = req.file.path;
    const extractDir = path.join('/tmp', `restore-${Date.now()}`);

    try {
        fs.mkdirSync(extractDir, { recursive: true });

        await exec(`tar -xzf "${uploadedFile}" -C "${extractDir}"`);
        logger.info(`[Restore] Archive extracted to ${extractDir}`);

        const findDumpPath = (dir) => {
            const items = fs.readdirSync(dir);

            if (items.includes('hysteria') && fs.statSync(path.join(dir, 'hysteria')).isDirectory()) {
                return dir;
            }

            if (items.length === 1 && fs.statSync(path.join(dir, items[0])).isDirectory()) {
                return findDumpPath(path.join(dir, items[0]));
            }

            return dir;
        };

        const dumpPath = findDumpPath(extractDir);
        logger.info(`[Restore] Dump path: ${dumpPath}`);

        const dumpContents = fs.readdirSync(dumpPath);
        logger.info(`[Restore] Dump contents: ${dumpContents.join(', ')}`);

        const mongoUri = config.MONGO_URI;
        const hysteriaDir = path.join(dumpPath, 'hysteria');
        const restoreCmd = `mongorestore --uri="${mongoUri}" --drop --gzip --db=hysteria "${hysteriaDir}"`;

        logger.info(`[Restore] DB folder: ${hysteriaDir}`);
        logger.info(`[Restore] Command: ${restoreCmd.replace(mongoUri, 'MONGO_URI')}`);

        const { stdout, stderr } = await exec(restoreCmd);
        if (stdout) logger.info(`[Restore] stdout: ${stdout}`);
        if (stderr) logger.info(`[Restore] stderr: ${stderr}`);

        logger.info(`[Restore] Database restored successfully`);

        fs.unlinkSync(uploadedFile);
        await exec(`rm -rf "${extractDir}"`);

        res.json({ success: true, message: 'База данных успешно восстановлена' });
    } catch (error) {
        logger.error(`[Restore] Error: ${error.message}`);
        if (error.stdout) logger.error(`[Restore] stdout: ${error.stdout}`);
        if (error.stderr) logger.error(`[Restore] stderr: ${error.stderr}`);

        try {
            if (fs.existsSync(uploadedFile)) fs.unlinkSync(uploadedFile);
            await exec(`rm -rf "${extractDir}"`);
        } catch (e) {}

        res.status(500).json({ error: error.message });
    }
});

module.exports = router;
