const fs = require('node:fs');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..');
const rendererRoot = path.join(projectRoot, 'src');
const assetRoot = path.join(projectRoot, 'assets');
const outputRoot = path.join(projectRoot, 'src-tauri', 'dist');

fs.rmSync(outputRoot, { recursive: true, force: true });
fs.mkdirSync(path.join(outputRoot, 'assets'), { recursive: true });

for (const entry of fs.readdirSync(rendererRoot)) {
  if (!['.html', '.js'].includes(path.extname(entry))) continue;
  fs.copyFileSync(path.join(rendererRoot, entry), path.join(outputRoot, entry));
}

for (const entry of fs.readdirSync(assetRoot)) {
  fs.copyFileSync(path.join(assetRoot, entry), path.join(outputRoot, 'assets', entry));
}

// Renderer-owned assets (bundled fonts) live under src/assets so the same
// relative URL works from src/index.html and from dist/index.html.
const rendererAssetRoot = path.join(rendererRoot, 'assets');
if (fs.existsSync(rendererAssetRoot)) {
  fs.cpSync(rendererAssetRoot, path.join(outputRoot, 'assets'), { recursive: true });
}

console.log(`CraftDock Tauri renderer bundled at ${path.relative(projectRoot, outputRoot)}`);
