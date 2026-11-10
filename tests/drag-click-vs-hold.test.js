// A simple click must open an instance or server; only a deliberate hold or
// real pointer movement may lift a card/row into a drag.
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

const downSource = extract(
  /^function instDragPointerDown\(e, id\) \{[\s\S]*?^\}/m,
  'instDragPointerDown()',
);
const moveSource = extract(
  /^function _instPointerMove\(e\) \{[\s\S]*?^\}/m,
  '_instPointerMove()',
);
const upSource = extract(
  /^function _instPointerUp\(e\) \{[\s\S]*?^\}/m,
  '_instPointerUp()',
);

const holdMatch = renderer.match(/const DRAG_HOLD_MS = (\d+);/);
assert.ok(holdMatch, 'DRAG_HOLD_MS is defined');
const holdMs = Number(holdMatch[1]);
const distanceMatch = renderer.match(/const DRAG_START_DISTANCE = (\d+);/);
assert.ok(distanceMatch, 'DRAG_START_DISTANCE is defined');
const startDistance = Number(distanceMatch[1]);

assert.ok(holdMs >= 300, `hold threshold ${holdMs}ms is long enough to distinguish a click`);
assert.ok(startDistance >= 8, `movement threshold ${startDistance}px leaves room for click jitter`);

function pointerEvent(card, { pointerId = 1, x = 10, y = 10 } = {}) {
  return {
    button: 0,
    pointerId,
    clientX: x,
    clientY: y,
    target: {
      closest(selector) {
        if (selector === '.library-card') return card;
        return null;
      },
    },
  };
}

function makeInstanceContext(drag = null) {
  const state = { begins: 0, scheduled: [], cleared: [], finished: null };
  const card = { dataset: { id: 'inst_1' }, isConnected: true };
  const context = vm.createContext({
    DRAG_HOLD_MS: holdMs,
    DRAG_START_DISTANCE: startDistance,
    _instDrag: drag,
    _instPress: null,
    _instDragSuppressClick: false,
    _libraryQuery: { trim: () => '' },
    setTimeout(fn, delay) {
      state.scheduled.push({ fn, delay });
      return state.scheduled.length;
    },
    clearTimeout(id) {
      state.cleared.push(id);
    },
    _instBeginDrag() {
      state.begins++;
    },
    _instUpdateDrag() {},
    _instFinishDrag(suppressClick) {
      state.finished = suppressClick;
    },
    _instPointerOutsideWindow() {
      return false;
    },
    moveInstanceInLibrary() {},
  });
  vm.runInContext(`${downSource}\n${moveSource}\n${upSource}`, context);
  return { card, context, state };
}

test('a short press clears the hold timer without lifting the instance', () => {
  const { card, context, state } = makeInstanceContext();
  const down = vm.runInContext('instDragPointerDown', context);
  const up = vm.runInContext('_instPointerUp', context);

  down(pointerEvent(card), 'inst_1');
  assert.equal(state.begins, 0, 'pointerdown does not start a drag');
  assert.equal(state.scheduled.length, 1);
  assert.equal(state.scheduled[0].delay, holdMs);

  up({ pointerId: 1, clientX: 10, clientY: 10 });
  assert.equal(vm.runInContext('_instPress', context), null, 'press state is cleared');
  assert.deepEqual(state.cleared, [1], 'pending hold timer is cancelled');
  assert.equal(state.begins, 0, 'a click never becomes a drag');
  assert.equal(
    vm.runInContext('_instDragSuppressClick', context),
    false,
    'a click is not suppressed',
  );
});

test('holding still lifts the instance into a drag', () => {
  const { card, context, state } = makeInstanceContext();
  const down = vm.runInContext('instDragPointerDown', context);

  down(pointerEvent(card), 'inst_1');
  state.scheduled[0].fn();
  assert.equal(state.begins, 1, 'the hold timer starts the drag');
});

test('small pointer jitter is ignored, but real movement starts a drag', () => {
  const { card, context, state } = makeInstanceContext();
  const down = vm.runInContext('instDragPointerDown', context);
  const move = vm.runInContext('_instPointerMove', context);

  down(pointerEvent(card), 'inst_1');
  move({ pointerId: 1, clientX: 10 + startDistance - 1, clientY: 10 + startDistance - 1 });
  assert.equal(state.begins, 0, 'movement below the threshold stays a click');

  move({ pointerId: 1, clientX: 10 + startDistance, clientY: 10 });
  assert.equal(state.begins, 1, 'movement past the threshold starts a drag');
});

test('releasing a lifted instance suppresses the click that follows the drag', () => {
  const drag = { pointerId: 1, id: 'inst_1', target: null, moved: false };
  const { context, state } = makeInstanceContext(drag);
  const up = vm.runInContext('_instPointerUp', context);

  up({ pointerId: 1, clientX: 10, clientY: 10 });
  assert.equal(state.finished, true, 'the drag is finished with click suppression');
  assert.equal(
    vm.runInContext('_instDragSuppressClick', context),
    true,
    'the trailing click is marked as consumed',
  );
});

test('server rows use the shared click-vs-hold thresholds and suppress post-drag clicks', () => {
  assert.match(renderer, /press\.timer = setTimeout\(begin, DRAG_HOLD_MS\);/);
  assert.match(
    renderer,
    /Math\.abs\(e\.clientX - press\.x\) < DRAG_START_DISTANCE\s*\n\s*&& Math\.abs\(e\.clientY - press\.y\) < DRAG_START_DISTANCE/,
  );
  assert.match(renderer, /_srvSuppressClick = true;\s*\n\s*setTimeout\(\(\) => \{ _srvSuppressClick = false; \}, 150\);/);
  assert.doesNotMatch(renderer, /_srvSuppressClick = drag\.moved \|\| drag\.to !== drag\.from/);
  assert.doesNotMatch(renderer, /setTimeout\((?:begin|_instBeginDrag), 80\)/);
});
