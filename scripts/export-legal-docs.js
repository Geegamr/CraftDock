// Writes TERMS.md and PRIVACY.md from the copy that ships in src/index.html.
//
// The legal text lives in the app so it renders with no network and works in
// both the Electron and Tauri builds. These repository copies exist for GitHub,
// releases and anyone who wants to read them without installing. Generate them
// instead of editing by hand, or the two will drift:
//
//   node scripts/export-legal-docs.js
//
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'src', 'index.html'), 'utf8');

function extract(name) {
  const marker = 'const ' + name + ' = `';
  const start = html.indexOf(marker);
  if (start === -1) throw new Error(name + ' not found in src/index.html');
  const from = start + marker.length;
  const end = html.indexOf('`;', from);
  if (end === -1) throw new Error('unterminated ' + name + ' in src/index.html');
  return html.slice(from, end);
}

for (const [file, name] of [['TERMS.md', 'LEGAL_TERMS'], ['PRIVACY.md', 'LEGAL_PRIVACY']]) {
  const text = extract(name).trimEnd() + '\n';
  fs.writeFileSync(path.join(root, file), text);
  console.log('wrote ' + file + ' (' + text.length + ' characters)');
}
