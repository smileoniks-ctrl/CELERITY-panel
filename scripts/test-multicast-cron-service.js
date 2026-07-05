const assert = require('assert');

const {
  createMulticastCronService,
  extractRunnableCommands,
  replaceManagedBlock,
} = require('../src/services/multicastCronService');

function createNode(id, ip = `10.0.0.${id}`) {
  return {
    _id: `node-${id}`,
    name: `Node ${id}`,
    ip,
    ssh: { username: 'root', password: 'secret' },
  };
}

(async () => {
  {
    const content = replaceManagedBlock('* * * * * /usr/bin/old\n', '*/5 * * * * /usr/bin/new\n');
    assert(content.includes('* * * * * /usr/bin/old\n'), 'user cron line should be preserved');
    assert(content.includes('# BEGIN C3 CELERITY MULTICAST CRON'), 'managed block begin marker should be added');
    assert(content.includes('*/5 * * * * /usr/bin/new\n'), 'managed block content should be added');
    assert(content.includes('# END C3 CELERITY MULTICAST CRON'), 'managed block end marker should be added');
  }

  {
    const current = [
      'SHELL=/bin/bash',
      '# BEGIN C3 CELERITY MULTICAST CRON',
      '* * * * * /usr/bin/old',
      '# END C3 CELERITY MULTICAST CRON',
      '0 0 * * * /usr/bin/user',
      '',
    ].join('\n');
    const content = replaceManagedBlock(current, '@daily /usr/bin/new\n');
    assert(!content.includes('/usr/bin/old'), 'old managed command should be removed');
    assert(content.includes('@daily /usr/bin/new\n'), 'new managed command should be present');
    assert(content.includes('SHELL=/bin/bash\n'), 'prefix should be preserved');
    assert(content.includes('0 0 * * * /usr/bin/user\n'), 'suffix should be preserved');
  }

  {
    const content = replaceManagedBlock([
      '* * * * * /usr/bin/user',
      '# BEGIN C3 CELERITY MULTICAST CRON',
      '*/10 * * * * /usr/bin/managed',
      '# END C3 CELERITY MULTICAST CRON',
      '',
    ].join('\n'), '');
    assert(content.includes('* * * * * /usr/bin/user\n'), 'empty block should preserve user cron');
    assert(!content.includes('C3 CELERITY MULTICAST CRON'), 'empty block should remove managed markers');
  }

  assert.throws(
    () => replaceManagedBlock('# BEGIN C3 CELERITY MULTICAST CRON\n* * * * * /usr/bin/job\n', '* * * * * /usr/bin/new\n'),
    /managed cron block/i,
    'unbalanced markers should be rejected'
  );
  assert.throws(
    () => replaceManagedBlock('', '# BEGIN C3 CELERITY MULTICAST CRON\n* * * * * /usr/bin/job\n'),
    /managed cron markers/i,
    'nested markers in raw block should be rejected'
  );

  {
    const commands = extractRunnableCommands([
      'SHELL=/bin/bash',
      '# comment',
      '*/5 * * * * /opt/job --flag',
      '@daily /opt/daily # keep inline comment',
      '* * * echo invalid',
      '',
    ].join('\n'));
    assert.deepStrictEqual(commands, ['/opt/job --flag', '/opt/daily # keep inline comment']);
  }

  {
    const calls = [];
    const remoteCronService = {
      validateCronUser: () => true,
      validateCronContent: () => true,
      getCron: async (node, user) => {
        calls.push({ method: 'getCron', nodeId: node._id, user });
        return { content: 'MAILTO=root\n', hash: `hash-${node._id}`, user };
      },
      saveCron: async (node, user, content, hash) => {
        calls.push({ method: 'saveCron', nodeId: node._id, user, content, hash });
        if (node._id === 'node-2') throw new Error('save failed');
        return { success: true, hash: `new-${node._id}`, backupPath: `/tmp/${node._id}` };
      },
      runCommandNow: async (node, user, command) => {
        calls.push({ method: 'runCommandNow', nodeId: node._id, user, command });
        return { code: 0, stdout: 'ok', stderr: '' };
      },
    };
    const service = createMulticastCronService({ remoteCronService, concurrency: 2 });
    const result = await service.applyCronBlockToNodes(
      [createNode(1), createNode(2)],
      { user: 'root', content: '*/5 * * * * /opt/job\n', runNow: true }
    );
    assert.strictEqual(result.summary.total, 2);
    assert.strictEqual(result.summary.saved, 1);
    assert.strictEqual(result.summary.failed, 1);
    assert.strictEqual(result.results[0].success, true);
    assert.strictEqual(result.results[0].runNow.length, 1);
    assert.strictEqual(result.results[1].success, false);
    assert.deepStrictEqual(
      calls.filter(call => call.method === 'saveCron').map(call => call.hash),
      ['hash-node-1', 'hash-node-2'],
      'saveCron should use the hash loaded from each node'
    );
    assert.deepStrictEqual(
      calls.filter(call => call.method === 'runCommandNow').map(call => call.nodeId),
      ['node-1'],
      'run-now should only execute after a successful save'
    );
  }

  {
    const calls = [];
    const remoteCronService = {
      validateCronUser: () => true,
      validateCronContent: () => true,
      getCron: async () => ({ content: replaceManagedBlock('', '* * * * * /opt/same\n'), hash: 'same-hash', user: 'root' }),
      saveCron: async () => {
        calls.push({ method: 'saveCron' });
        return { success: true };
      },
      runCommandNow: async () => {
        calls.push({ method: 'runCommandNow' });
        return { code: 0, stdout: '', stderr: '' };
      },
    };
    const service = createMulticastCronService({ remoteCronService });
    const result = await service.applyCronBlockToNodes(
      [createNode(1)],
      { user: 'root', content: '* * * * * /opt/same\n', runNow: false }
    );
    assert.strictEqual(result.results[0].skipped, true);
    assert.strictEqual(calls.length, 0, 'unchanged content should not be saved or run');
  }

  {
    const remoteCronService = {
      validateCronUser: () => {
        throw new Error('Invalid cron user');
      },
      validateCronContent: () => true,
    };
    const service = createMulticastCronService({ remoteCronService });
    await assert.rejects(
      () => service.applyCronBlockToNodes([createNode(1)], { user: 'bad user', content: '* * * * * /opt/job\n' }),
      (error) => error.statusCode === 400 && error.expose === true && /Invalid cron user/.test(error.message)
    );
  }

  {
    const remoteCronService = {
      validateCronUser: () => true,
      validateCronContent: () => {
        throw new Error('Invalid cron line 1');
      },
    };
    const service = createMulticastCronService({ remoteCronService });
    await assert.rejects(
      () => service.applyCronBlockToNodes([createNode(1)], { user: 'root', content: '* * * bad\n' }),
      (error) => error.statusCode === 400 && error.expose === true && /Invalid cron line/.test(error.message)
    );
  }

  console.log('multicast cron service tests passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
