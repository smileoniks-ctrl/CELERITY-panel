const assert = require('assert');
const crypto = require('crypto');

const {
  createRemoteCronService,
  validateCronUser,
  validateCronContent,
} = require('../src/services/remoteCronService');

function hash(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

function createNode(username = 'root') {
  return {
    _id: 'node-1',
    name: 'Node 1',
    ip: '127.0.0.1',
    ssh: { username },
  };
}

function makeSSHClass(handler, options = {}) {
  const instances = [];

  class FakeSSH {
    constructor(node) {
      this.node = node;
      this.commands = [];
      this.connected = false;
      this.disconnected = false;
      instances.push(this);
    }

    async connect() {
      this.connected = true;
    }

    async exec(command) {
      this.commands.push(command);
      return handler(command, this);
    }

    async writeFile(remotePath, content) {
      this.commands.push(`writeFile:${remotePath}:${content}`);
      if (options.writeFile) {
        return options.writeFile(remotePath, content, this);
      }
      return undefined;
    }

    disconnect() {
      this.disconnected = true;
    }
  }

  FakeSSH.instances = instances;
  return FakeSSH;
}

(async () => {
  assert.doesNotThrow(() => validateCronUser('root'));
  assert.doesNotThrow(() => validateCronUser('backup-user_1'));
  assert.throws(() => validateCronUser(''), /Invalid cron user/);
  assert.throws(() => validateCronUser('bad user'), /Invalid cron user/);
  assert.throws(() => validateCronUser('bad;user'), /Invalid cron user/);

  assert.doesNotThrow(() => validateCronContent('SHELL=/bin/bash\n# comment\n*/5 * * * * /usr/bin/true\n@reboot /usr/bin/true\n'));
  assert.throws(() => validateCronContent('* * * * /usr/bin/true'), /Invalid cron line/);
  assert.throws(() => validateCronContent('NAME'), /Invalid cron line/);
  assert.throws(() => validateCronContent('A=B\0'), /NUL/);
  assert.throws(() => validateCronContent('x'.repeat(64 * 1024 + 1)), /64 KiB/);

  {
    const SSHClass = makeSSHClass(async (command) => {
      assert.strictEqual(command, 'crontab -l');
      return { code: 0, stdout: 'SHELL=/bin/bash\r\n* * * * * echo ok\r\n', stderr: '' };
    });
    const service = createRemoteCronService({ SSHClass });
    const result = await service.getCron(createNode('root'), 'root');
    assert.deepStrictEqual(result, {
      content: 'SHELL=/bin/bash\n* * * * * echo ok\n',
      hash: hash('SHELL=/bin/bash\n* * * * * echo ok\n'),
      user: 'root',
    });
    assert.strictEqual(SSHClass.instances[0].disconnected, true);
  }

  {
    const SSHClass = makeSSHClass(async (command) => {
      assert.strictEqual(command, 'sudo -n crontab -u other -l');
      return { code: 1, stdout: '', stderr: 'no crontab for other' };
    });
    const service = createRemoteCronService({ SSHClass });
    const result = await service.getCron(createNode('deployer'), 'other');
    assert.strictEqual(result.content, '');
    assert.strictEqual(result.hash, hash(''));
  }

  {
    const SSHClass = makeSSHClass(async (command) => {
      if (command === 'crontab -u app -l') {
        return { code: 0, stdout: '* * * * * echo changed\n', stderr: '' };
      }
      throw new Error(`unexpected command: ${command}`);
    });
    const service = createRemoteCronService({ SSHClass });
    await assert.rejects(
      () => service.saveCron(createNode('root'), 'app', '* * * * * echo new\n', hash('* * * * * echo old\n')),
      (error) => error.statusCode === 409 && /Cron changed/.test(error.message)
    );
    assert.strictEqual(SSHClass.instances[0].disconnected, true);
  }

  {
    const SSHClass = makeSSHClass(async (command) => {
      if (command === 'crontab -u app -l') {
        return { code: 0, stdout: '* * * * * echo old\n', stderr: '' };
      }
      throw new Error(`unexpected command: ${command}`);
    });
    const service = createRemoteCronService({ SSHClass });
    await assert.rejects(
      () => service.saveCron(createNode('root'), 'app', '* * * * * echo new\n', ''),
      /Base hash is required/
    );
    assert.strictEqual(SSHClass.instances.length, 0);
  }

  {
    const rawContent = '* * * * * echo safe; not shell input\n';
    const SSHClass = makeSSHClass(async (command) => {
      if (command === 'crontab -u app -l') {
        return { code: 0, stdout: '* * * * * echo old\n', stderr: '' };
      }
      if (command.startsWith('umask 077; mkdir -p /tmp/celerity-cron-app-1710000000000-')) {
        assert.match(command, /^umask 077; mkdir -p \/tmp\/celerity-cron-app-1710000000000-[a-f0-9]{16} && chmod 700 \/tmp\/celerity-cron-app-1710000000000-[a-f0-9]{16}$/);
        return { code: 0, stdout: '', stderr: '' };
      }
      if (command.startsWith('umask 077 && crontab -u app -l > /tmp/celerity-cron-backup-app-')) {
        assert.match(command, /^umask 077 && crontab -u app -l > \/tmp\/celerity-cron-backup-app-1710000000000-[a-f0-9]{16}\.txt$/);
        return { code: 0, stdout: '', stderr: '' };
      }
      if (command.includes('base64 -d') && command.includes('crontab -u app')) {
        assert(!command.includes(rawContent), 'raw crontab content must not be concatenated into shell command');
        assert.match(command, /^base64 -d < \/tmp\/celerity-cron-app-1710000000000-[a-f0-9]{16}\/crontab\.b64 > \/tmp\/celerity-cron-app-1710000000000-[a-f0-9]{16}\/crontab\.txt && crontab -u app \/tmp\/celerity-cron-app-1710000000000-[a-f0-9]{16}\/crontab\.txt$/);
        return { code: 0, stdout: '', stderr: '' };
      }
      if (command.startsWith('rm -rf /tmp/celerity-cron-app-1710000000000-')) {
        return { code: 0, stdout: '', stderr: '' };
      }
      throw new Error(`unexpected command: ${command}`);
    });
    const service = createRemoteCronService({ SSHClass, now: () => 1710000000000 });
    const result = await service.saveCron(createNode('root'), 'app', rawContent, hash('* * * * * echo old\n'));
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.hash, hash(rawContent));
    assert.match(result.backupPath, /^\/tmp\/celerity-cron-backup-app-1710000000000-[a-f0-9]{16}\.txt$/);
    assert(SSHClass.instances[0].commands.some(command => /^writeFile:\/tmp\/celerity-cron-app-1710000000000-[a-f0-9]{16}\/crontab\.b64:/.test(command)));
    assert(!SSHClass.instances[0].commands.some(command => /writeFile:\/tmp\/celerity-cron-app-1710000000000\.b64:/.test(command)));
    assert(SSHClass.instances[0].commands.some(command => /rm -rf \/tmp\/celerity-cron-app-1710000000000-[a-f0-9]{16}/.test(command)));
  }

  {
    const SSHClass = makeSSHClass(async (command) => {
      if (command === 'crontab -u app -l') {
        return { code: 0, stdout: '* * * * * echo old\n', stderr: '' };
      }
      if (command.startsWith('umask 077; mkdir -p /tmp/celerity-cron-app-1710000000000-')) {
        return { code: 0, stdout: '', stderr: '' };
      }
      if (command.startsWith('umask 077 && crontab -u app -l > /tmp/celerity-cron-backup-app-')) {
        return { code: 0, stdout: '', stderr: '' };
      }
      if (command.startsWith('rm -rf /tmp/celerity-cron-app-1710000000000-')) {
        return { code: 7, stdout: '', stderr: 'cleanup failed' };
      }
      throw new Error(`unexpected command: ${command}`);
    }, {
      writeFile: async () => {
        throw new Error('write failed');
      },
    });
    const service = createRemoteCronService({ SSHClass, now: () => 1710000000000 });
    await assert.rejects(
      () => service.saveCron(createNode('root'), 'app', '* * * * * echo new\n', hash('* * * * * echo old\n')),
      /write failed/
    );
    assert(SSHClass.instances[0].commands.some(command => /^rm -rf \/tmp\/celerity-cron-app-1710000000000-[a-f0-9]{16}$/.test(command)));
  }

  {
    let currentContent = '* * * * * echo old\n';
    let readCount = 0;
    const SSHClass = makeSSHClass(async (command) => {
      if (command === 'crontab -u app -l') {
        readCount += 1;
        return { code: 0, stdout: currentContent, stderr: '' };
      }
      if (command.startsWith('umask 077; mkdir -p /tmp/celerity-cron-app-1710000000000-')) {
        return { code: 0, stdout: '', stderr: '' };
      }
      if (command.startsWith('umask 077 && crontab -u app -l > /tmp/celerity-cron-backup-app-')) {
        return { code: 0, stdout: '', stderr: '' };
      }
      if (command.includes('base64 -d') && command.includes('crontab -u app')) {
        currentContent = '* * * * * echo first\n';
        return { code: 0, stdout: '', stderr: '' };
      }
      throw new Error(`unexpected command: ${command}`);
    });
    const service = createRemoteCronService({ SSHClass, now: () => 1710000000000 });
    const baseHash = hash('* * * * * echo old\n');
    const results = await Promise.allSettled([
      service.saveCron(createNode('root'), 'app', '* * * * * echo first\n', baseHash),
      service.saveCron(createNode('root'), 'app', '* * * * * echo second\n', baseHash),
    ]);
    assert.strictEqual(results.filter(result => result.status === 'fulfilled').length, 1);
    const rejected = results.find(result => result.status === 'rejected');
    assert(rejected, 'one parallel save must reject');
    assert.strictEqual(rejected.reason.statusCode, 409);
    assert.match(rejected.reason.message, /Cron changed/);
    assert.strictEqual(readCount, 2);
  }

  {
    const SSHClass = makeSSHClass(async (command) => {
      if (command === 'crontab -u app -l') {
        return { code: 0, stdout: '* * * * * echo old\n', stderr: '' };
      }
      if (command.startsWith('umask 077; mkdir -p /tmp/celerity-cron-app-1710000000000-')) {
        return { code: 0, stdout: '', stderr: '' };
      }
      if (command.startsWith('umask 077 && crontab -u app -l > /tmp/celerity-cron-backup-app-')) {
        return { code: 1, stdout: '', stderr: 'permission denied' };
      }
      if (command.startsWith('rm -rf /tmp/celerity-cron-app-1710000000000-')) {
        return { code: 0, stdout: '', stderr: '' };
      }
      throw new Error(`unexpected command: ${command}`);
    });
    const service = createRemoteCronService({ SSHClass, now: () => 1710000000000 });
    await assert.rejects(
      () => service.saveCron(createNode('root'), 'app', '* * * * * echo new\n', hash('* * * * * echo old\n')),
      (error) => error.statusCode === 502 && /permission denied/.test(error.message)
    );
    assert(!SSHClass.instances[0].commands.some(command => command.startsWith('writeFile:')));
    assert(!SSHClass.instances[0].commands.some(command => command.includes('base64 -d')));
    assert(SSHClass.instances[0].commands.some(command => /^rm -rf \/tmp\/celerity-cron-app-1710000000000-[a-f0-9]{16}$/.test(command)));
  }

  {
    const SSHClass = makeSSHClass(async (command) => {
      if (command === 'crontab -u app -l') {
        return { code: 0, stdout: '* * * * * echo old\n', stderr: '' };
      }
      if (command.startsWith('umask 077; mkdir -p /tmp/celerity-cron-app-1710000000000-')) {
        return { code: 0, stdout: '', stderr: '' };
      }
      if (command.startsWith('umask 077 && crontab -u app -l > /tmp/celerity-cron-backup-app-')) {
        return { code: 1, stdout: '', stderr: 'no crontab for app' };
      }
      if (command.includes('base64 -d') && command.includes('crontab -u app')) {
        return { code: 0, stdout: '', stderr: '' };
      }
      throw new Error(`unexpected command: ${command}`);
    });
    const service = createRemoteCronService({ SSHClass, now: () => 1710000000000 });
    const result = await service.saveCron(createNode('root'), 'app', '* * * * * echo new\n', hash('* * * * * echo old\n'));
    assert.strictEqual(result.success, true);
    assert(SSHClass.instances[0].commands.some(command => command.startsWith('writeFile:')));
  }

  {
    const SSHClass = makeSSHClass(async (command) => {
      assert.strictEqual(command, "bash -lc 'echo '\"'\"'hi'\"'\"''");
      return { code: 7, stdout: 'o'.repeat(20050), stderr: 'e'.repeat(20050) };
    });
    const service = createRemoteCronService({ SSHClass });
    const result = await service.runCommandNow(createNode(), 'root', "echo 'hi'");
    assert.strictEqual(result.code, 7);
    assert.strictEqual(result.stdout.length, 20000);
    assert.strictEqual(result.stderr.length, 20000);
    await assert.rejects(() => service.runCommandNow(createNode(), 'root', ''), /Command is required/);
    await assert.rejects(() => service.runCommandNow(createNode(), 'root', 'x'.repeat(4097)), /4096/);
  }

  {
    const rootSSHClass = makeSSHClass(async (command) => {
      assert.strictEqual(command, "sudo -n -u app bash -lc 'echo app'");
      return { code: 0, stdout: 'app\n', stderr: '' };
    });
    const rootService = createRemoteCronService({ SSHClass: rootSSHClass });
    await rootService.runCommandNow(createNode('root'), 'app', 'echo app');

    const sameUserSSHClass = makeSSHClass(async (command) => {
      assert.strictEqual(command, "bash -lc 'echo admin'");
      return { code: 0, stdout: 'admin\n', stderr: '' };
    });
    const sameUserService = createRemoteCronService({ SSHClass: sameUserSSHClass });
    await sameUserService.runCommandNow(createNode('admin'), 'admin', 'echo admin');

    const sudoSSHClass = makeSSHClass(async (command) => {
      assert.strictEqual(command, "sudo -n -u app bash -lc 'echo app'");
      return { code: 0, stdout: 'app\n', stderr: '' };
    });
    const sudoService = createRemoteCronService({ SSHClass: sudoSSHClass });
    await sudoService.runCommandNow(createNode('deployer'), 'app', 'echo app');
    await assert.rejects(() => sudoService.runCommandNow(createNode('deployer'), 'bad user', 'echo app'), /Invalid cron user/);

    const nonRootToRootSSHClass = makeSSHClass(async (command) => {
      assert.strictEqual(command, "sudo -n -u root bash -lc 'echo root'");
      return { code: 0, stdout: 'root\n', stderr: '' };
    });
    const nonRootToRootService = createRemoteCronService({ SSHClass: nonRootToRootSSHClass });
    await nonRootToRootService.runCommandNow(createNode('admin'), 'root', 'echo root');
  }

  {
    const SSHClass = makeSSHClass(async (command) => {
      if (command === 'systemctl is-active cron') return { code: 3, stdout: 'inactive\n', stderr: '' };
      if (command === 'systemctl is-active crond') return { code: 0, stdout: 'active\n', stderr: '' };
      if (command === 'sudo -n systemctl reload cron') return { code: 1, stdout: '', stderr: 'failed' };
      if (command === 'sudo -n systemctl reload crond') return { code: 0, stdout: '', stderr: '' };
      if (command === 'sudo -n systemctl restart cron') return { code: 1, stdout: '', stderr: 'failed' };
      if (command === 'sudo -n systemctl restart crond') return { code: 0, stdout: '', stderr: '' };
      throw new Error(`unexpected command: ${command}`);
    });
    const service = createRemoteCronService({ SSHClass });
    assert.deepStrictEqual(await service.getCronServiceStatus(createNode()), {
      service: 'crond',
      active: true,
      checked: [
        { service: 'cron', active: false, code: 3, stdout: 'inactive', stderr: '' },
        { service: 'crond', active: true, code: 0, stdout: 'active', stderr: '' },
      ],
    });
    assert.deepStrictEqual(await service.reloadCronService(createNode()), {
      success: true,
      action: 'reload',
      service: 'crond',
      code: 0,
      stdout: '',
      stderr: '',
    });
    assert.deepStrictEqual(await service.restartCronService(createNode()), {
      success: true,
      action: 'restart',
      service: 'crond',
      code: 0,
      stdout: '',
      stderr: '',
    });
  }

  console.log('remote cron service tests passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
