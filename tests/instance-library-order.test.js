// The instance library is sorted by a persisted preference instead of a
// hand-maintained card order. Dragging only moves cards between categories.
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

const normalizeSource = extract(
  /^function normalizeLibrarySort\(value\) \{[\s\S]*?^\}/m,
  'normalizeLibrarySort()',
);
const sortSource = extract(
  /^function sortInstancesForLibrary\(instances, mode\) \{[\s\S]*?^\}/m,
  'sortInstancesForLibrary()',
);
const categorySortSource = extract(
  /^function sortCategoriesForLibrary\(categories, instances, mode\) \{[\s\S]*?^\}/m,
  'sortCategoriesForLibrary()',
);

const context = vm.createContext({});
vm.runInContext(`${normalizeSource}\n${sortSource}\n${categorySortSource}`, context);

const sortInstances = vm.runInContext('sortInstancesForLibrary', context);
const sortCategories = vm.runInContext('sortCategoriesForLibrary', context);
const normalizeSort = vm.runInContext('normalizeLibrarySort', context);

function ids(value) {
  return [...value].map(item => item.id);
}

const instances = [
  { id: 'b', name: 'Beta', totalPlayMinutes: 90, lastPlayed: 1000 },
  { id: 'a', name: 'alpha', totalPlayMinutes: 240, lastPlayed: 3000 },
  { id: 'c', name: 'Charlie', totalPlayMinutes: 90, addedAt: 2000 },
  { id: 'd', name: 'Delta', totalPlayMinutes: 0 },
];

test('unknown sort modes fall back to Name: A-Z', () => {
  assert.equal(normalizeSort('name-desc'), 'name-desc');
  assert.equal(normalizeSort('playtime'), 'playtime');
  assert.equal(normalizeSort('recent'), 'recent');
  assert.equal(normalizeSort('stale'), 'name-asc');
  assert.equal(normalizeSort(null), 'name-asc');
});

test('name sorting is case-insensitive and numeric, with a descending mode', () => {
  const packs = [
    { id: 'ten', name: 'Pack 10' },
    { id: 'two', name: 'Pack 2' },
    { id: 'alpha', name: 'alpha' },
  ];

  assert.deepEqual(ids(sortInstances(packs, 'name-asc')), ['alpha', 'two', 'ten']);
  assert.deepEqual(ids(sortInstances(packs, 'name-desc')), ['ten', 'two', 'alpha']);
  assert.deepEqual(ids(sortInstances(instances, 'name-asc')), ['a', 'b', 'c', 'd']);
  assert.deepEqual(ids(sortInstances(instances, 'name-desc')), ['d', 'c', 'b', 'a']);
});

test('playtime sorts highest first and breaks ties by name', () => {
  assert.deepEqual(ids(sortInstances(instances, 'playtime')), ['a', 'b', 'c', 'd']);
});

test('recent play sorts newest first, falls back to addedAt, then by name', () => {
  assert.deepEqual(ids(sortInstances(instances, 'recent')), ['a', 'c', 'b', 'd']);
});

test('category sections follow the same sort preference', () => {
  const categories = [
    { id: 'work', name: 'Work' },
    { id: 'alpha', name: 'alpha' },
    { id: 'empty', name: 'Empty' },
  ];
  const categoryInstances = [
    { id: 'w1', categoryId: 'work', totalPlayMinutes: 60, lastPlayed: 100 },
    { id: 'w2', categoryId: 'work', totalPlayMinutes: 10, lastPlayed: 400 },
    { id: 'a1', categoryId: 'alpha', totalPlayMinutes: 120, lastPlayed: 300 },
  ];

  assert.deepEqual(ids(sortCategories(categories, categoryInstances, 'name-asc')), ['alpha', 'empty', 'work']);
  assert.deepEqual(ids(sortCategories(categories, categoryInstances, 'name-desc')), ['work', 'empty', 'alpha']);
  assert.deepEqual(ids(sortCategories(categories, categoryInstances, 'playtime')), ['alpha', 'work', 'empty']);
  assert.deepEqual(ids(sortCategories(categories, categoryInstances, 'recent')), ['work', 'alpha', 'empty']);
});

test('the library exposes every sort mode and no manual order store', () => {
  for (const label of ['Name: A-Z', 'Name: Z-A', 'Playtime', 'Recent Play']) {
    assert.ok(renderer.includes(`>${label}</option>`), `${label} is available in the sort control`);
  }
  assert.match(renderer, /craftdock:library-sort/);
  assert.match(renderer, /sortCategoriesForLibrary\(categories, instances, _librarySort\)/);
  assert.match(renderer, /for \(const cat of sortedCategories\)/);
  assert.doesNotMatch(renderer, /InstanceOrderStore|orderInstancesForLibrary|normalizedInstanceOrderForLibrary|reorderInstanceIdsForLibrary/);
  assert.match(renderer, /Drag onto another category to move/);
  assert.match(renderer, /Move to category/);
  assert.match(renderer, /No categories yet/);
  assert.match(renderer, /data-category-menu/);
  assert.match(renderer, /instance-submenu/);
  assert.match(renderer, /instance-submenu-bridge/);
  assert.match(renderer, /data-move-category/);
  assert.match(renderer, /moveInstanceInLibrary\(id, categoryId\)/);
});
