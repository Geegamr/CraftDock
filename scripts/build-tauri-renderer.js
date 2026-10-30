const fs = require('node:fs');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..');
const rendererRoot = path.join(projectRoot, 'src');
const assetRoot = path.join(projectRoot, 'assets');
const outputRoot = path.join(projectRoot, 'src-tauri', 'dist');

fs.rmSync(outputRoot, { recursive: true, force: true });
fs.mkdirSync(path.join(outputRoot, 'assets'), { recursive: true });

for (const entry of fs.readdirSync(rendererRoot)) {
  if (path.extname(entry) !== '.html') continue;
  fs.copyFileSync(path.join(rendererRoot, entry), path.join(outputRoot, entry));
}

for (const entry of fs.readdirSync(assetRoot)) {
  fs.copyFileSync(path.join(assetRoot, entry), path.join(outputRoot, 'assets', entry));
}

console.log(`CraftDock Tauri renderer bundled at ${path.relative(projectRoot, outputRoot)}`);
