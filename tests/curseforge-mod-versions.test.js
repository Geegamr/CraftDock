// The per-instance version picker normalizes CurseForge files to the same shape
// it already uses for Modrinth, including newest-first order and CDN fallback.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const renderer = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.html'), 'utf8');

function extract(pattern, label) {
  const match = renderer.match(pattern);
  assert.ok(match, `${label} exists in the renderer`);
  return match[0];
}

const loaderNames = extract(/^const MB_CF_LOADER_NAMES = \{[^\n]*\};/m, 'CurseForge loader names');
const fileUrl = extract(/^function cfFileDownloadUrl\(file\) \{[\s\S]*?^\}/m, 'cfFileDownloadUrl()');
const versions = extract(
  /^async function fetchCurseForgeModVersions\(mod, mcVer, loader\) \{[\s\S]*?^\}/m,
  'fetchCurseForgeModVersions()',
);

test('CurseForge files become a newest-first, downloadable version list', async () => {
  const calls = [];
  const context = vm.createContext({
    resourceApi: () => ({
      curseforgeModFiles: async (...args) => {
        calls.push(args);
        return {
          success: true,
          data: [
            { id: 1001, fileName: 'old.jar', displayName: 'Old', fileDate: '2024-01-01T00:00:00Z', gameVersions: ['1.20.1'], modLoader: 4 },
            { id: 3000, fileName: 'new.jar', displayName: 'New', fileDate: '2025-01-01T00:00:00Z', gameVersions: ['1.21.1'], modLoader: 4, downloadUrl: 'https://cdn.example/new.jar' },
            { id: 2000, fileName: 'fallback.jar', fileDate: '2024-06-01T00:00:00Z', gameVersions: ['1.21.1'], modLoader: 1 },
            { fileName: 'missing-id.jar' },
          ],
        };
      },
    }),
  });
  vm.runInContext(`${loaderNames}\n${fileUrl}\n${versions}`, context);

  const list = await vm.runInContext(
    "fetchCurseForgeModVersions({ id: '238222' }, '1.21.1', 'fabric')",
    context,
  );

  assert.deepEqual(calls, [['238222', '1.21.1', 'fabric']]);
  assert.deepEqual(list.map(version => version.id), ['3000', '2000', '1001']);
  assert.equal(list[0].version_number, 'New');
  assert.deepEqual([...list[0].game_versions], ['1.21.1']);
  assert.deepEqual([...list[0].loaders], ['fabric']);
  assert.equal(list[0].files[0].url, 'https://cdn.example/new.jar');
  assert.equal(list[1].files[0].url, 'https://edge.forgecdn.net/files/2/0/fallback.jar');
  assert.deepEqual([...list[1].loaders], ['forge']);
});
