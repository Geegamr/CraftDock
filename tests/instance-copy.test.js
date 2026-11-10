const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const { copyInstanceDirectory, hashFile } = require('../instance-copy');

function tempRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'craftdock-instance-copy-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function write(filePath, content = '') {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

test('copying an instance preserves every file and verifies each SHA-256', async t => {
  const root = tempRoot(t);
  const src = path.join(root, 'instances', 'Original');
  const dest = path.join(root, 'instances', 'Copy');

  write(path.join(src, 'instance.json'), JSON.stringify({ id: 'original', name: 'Original' }));
  write(path.join(src, 'mods', 'example.jar'), crypto.randomBytes(64 * 1024));
  write(path.join(src, 'config', 'nested', 'settings.toml'), 'enabled = true\n');
  write(path.join(src, 'saves', 'world', 'level.dat'), 'world header');
  fs.mkdirSync(path.join(src, 'empty-folder'));

  const progress = [];
  const result = await copyInstanceDirectory(src, dest, {
    onProgress: state => progress.push(state),
  });

  assert.equal(result.files, 4);
  assert.equal(result.links, 0);
  assert.ok(result.bytes > 0);
  assert.equal(progress.at(-1).copiedFiles, result.files);
  assert.equal(progress.at(-1).copiedBytes, result.bytes);
  assert.ok(fs.existsSync(path.join(dest, 'empty-folder')));

  for (const relative of ['instance.json', 'mods/example.jar', 'config/nested/settings.toml', 'saves/world/level.dat']) {
    assert.equal(await hashFile(path.join(src, relative)), await hashFile(path.join(dest, relative)));
  }
});

test('the verifier ships inside the packaged app', () => {
  const packageConfig = require('../package.json');
  assert.ok(packageConfig.build.files.includes('instance-copy.js'));
});

test('copying refuses to overwrite an existing destination', async t => {
  const root = tempRoot(t);
  const src = path.join(root, 'src');
  const dest = path.join(root, 'dest');
  write(path.join(src, 'a.txt'), 'new');
  write(path.join(dest, 'a.txt'), 'keep');

  await assert.rejects(() => copyInstanceDirectory(src, dest), /EEXIST/);
  assert.equal(fs.readFileSync(path.join(dest, 'a.txt'), 'utf8'), 'keep');
});

test('a paused copy waits at a checkpoint and resumes', async t => {
  const root = tempRoot(t);
  const src = path.join(root, 'src');
  const dest = path.join(root, 'dest');
  for (let i = 0; i < 12; i += 1) write(path.join(src, `file-${i}.txt`), `content-${i}`);

  let releasePause;
  let releaseResume;
  const paused = new Promise(resolve => { releasePause = resolve; });
  const resume = new Promise(resolve => { releaseResume = resolve; });
  let didPause = false;

  const copyPromise = copyInstanceDirectory(src, dest, {
    onCheckpoint: async () => {
      if (!didPause && fs.existsSync(dest)) {
        didPause = true;
        releasePause();
        await resume;
      }
    },
  });

  await paused;
  let settled = false;
  copyPromise.then(() => { settled = true; }, () => { settled = true; });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(settled, false);
  releaseResume();

  const result = await copyPromise;
  assert.equal(result.files, 12);
  for (let i = 0; i < 12; i += 1) {
    assert.equal(fs.readFileSync(path.join(dest, `file-${i}.txt`), 'utf8'), `content-${i}`);
  }
});

test('cancelling at a checkpoint removes the partial destination', async t => {
  const root = tempRoot(t);
  const src = path.join(root, 'src');
  const dest = path.join(root, 'dest');
  write(path.join(src, 'one.txt'), 'one');
  write(path.join(src, 'two.txt'), 'two');

  let triggered = false;
  await assert.rejects(() => copyInstanceDirectory(src, dest, {
    onCheckpoint: async () => {
      if (!triggered && fs.existsSync(dest)) {
        triggered = true;
        const error = new Error('Copy cancelled');
        error.code = 'ECOPY_CANCELLED';
        throw error;
      }
    },
  }), error => error.code === 'ECOPY_CANCELLED');

  assert.equal(fs.existsSync(dest), false);
});
