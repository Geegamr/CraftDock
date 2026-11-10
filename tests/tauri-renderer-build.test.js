const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const projectRoot = path.resolve(__dirname, '..');
const scriptPath = path.join(projectRoot, 'scripts', 'build-tauri-renderer.js');
const outputRoot = path.join(projectRoot, 'src-tauri', 'dist');
const htmlPath = path.join(outputRoot, 'index.html');

test('Tauri renderer bundle mirrors the existing renderer', () => {
  execFileSync(process.execPath, [scriptPath], { cwd: projectRoot });

  assert.equal(
    fs.readFileSync(htmlPath, 'utf8'),
    fs.readFileSync(path.join(projectRoot, 'src', 'index.html'), 'utf8'),
  );
  assert.ok(fs.existsSync(path.join(outputRoot, 'assets', 'icon.svg')));
  assert.ok(fs.existsSync(path.join(outputRoot, 'gallery.js')), 'the gallery script is copied into the bundle');
});

test('every relative renderer reference resolves inside the bundle', () => {
  const html = fs.readFileSync(htmlPath, 'utf8');
  const references = [...html.matchAll(/(?:src|href)="(\.\.?\/[^"$]*?)"/g)].map((match) => match[1]);

  assert.ok(references.includes('../assets/icon.svg'));
  for (const reference of references) {
    const resolved = path.join(outputRoot, path.posix.normalize(path.posix.join('/', reference)));
    assert.ok(fs.existsSync(resolved), `${reference} is missing from the bundle`);
  }
});
