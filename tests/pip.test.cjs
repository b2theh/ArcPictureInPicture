const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const code = fs.readFileSync(path.join(__dirname, '../pip.uc.js'), 'utf8');
const AUTO = 'zen.mods.arc-pip.auto';
const ROOT = 'media.videocontrols.picture-in-picture.';

function environment(initial = {}) {
  const values = new Map(Object.entries(initial));
  const observers = new Map();
  const shared = {};
  const prefs = {
    prefHasUserValue: n => values.has(n),
    getBoolPref: (n, fallback) => values.get(n) ?? fallback,
    setBoolPref(n, v) { values.set(n, v); observers.get(n)?.observe(); },
    clearUserPref: n => values.delete(n),
    addObserver: (n, o) => observers.set(n, o),
    removeObserver: n => observers.delete(n),
  };
  const open = () => {
    const window = { addEventListener() {}, removeEventListener() {} };
    const context = vm.createContext({
      window, location: { href: 'chrome://browser/content/browser.xhtml' },
      ChromeUtils: { importESModule: () => ({ PictureInPicture: shared }) },
      Services: { prefs },
    });
    vm.runInContext(code, context);
    return { window, reload: () => vm.runInContext(code, context), close: () => window.arcPictureInPicture.destroy() };
  };
  return { values, observers, prefs, open };
}

test('manual mode enables the native video menu and disables both automatic triggers', () => {
  const env = environment();
  const win = env.open();
  assert.equal(env.values.get(ROOT + 'enabled'), true);
  assert.equal(env.values.get(ROOT + 'enable-when-switching-tabs.enabled'), false);
  assert.equal(env.values.get(ROOT + 'enable-when-occluded.enabled'), false);
  env.prefs.setBoolPref(AUTO, true);
  assert.equal(env.values.get(ROOT + 'enable-when-switching-tabs.enabled'), true);
  assert.equal(env.values.get(ROOT + 'enable-when-occluded.enabled'), true);
  env.prefs.setBoolPref(AUTO, false);
  assert.equal(env.values.get(ROOT + 'enable-when-switching-tabs.enabled'), false);
  win.close();
  assert.equal(env.values.has(ROOT + 'enabled'), false);
  assert.equal(env.observers.size, 0);
});

test('multiple windows retain overrides until the last owner leaves, then restore exact user preferences', () => {
  const initial = { [AUTO]: true, [ROOT + 'enabled']: false, [ROOT + 'enable-when-occluded.enabled']: true };
  const env = environment(initial);
  const a = env.open();
  const b = env.open();
  a.close();
  assert.equal(env.values.get(ROOT + 'enabled'), true);
  b.close();
  assert.deepEqual(Object.fromEntries(env.values), initial);
});

test('reloading a script does not accumulate observers or lose original values', () => {
  const env = environment({ [ROOT + 'enabled']: false });
  const win = env.open();
  win.reload();
  assert.equal(env.observers.size, 1);
  const controller = win.window.arcPictureInPicture;
  controller.destroy();
  controller.destroy();
  assert.equal(env.values.get(ROOT + 'enabled'), false);
  assert.equal(env.values.has(ROOT + 'enable-when-switching-tabs.enabled'), false);
});

function player({ left = 500, top = 300, screenLeft = 0, screenTop = 0 } = {}) {
  const handlers = new Map();
  const captured = new Set();
  const moves = [];
  const controls = {
    addEventListener: (n, cb) => handlers.set(n, cb),
    removeEventListener: n => handlers.delete(n),
    setPointerCapture: id => captured.add(id),
    hasPointerCapture: id => captured.has(id),
    releasePointerCapture: id => captured.delete(id),
    appendChild() {},
  };
  const elements = new Map(['unpip', 'minimize', 'close'].map(id => [id, { appendChild() {} }]));
  elements.set('controls', controls);
  const window = {
    screenX: left, screenY: top, outerWidth: 400, outerHeight: 225,
    screen: { availLeft: screenLeft, availTop: screenTop, availWidth: 1440, availHeight: 900 },
    addEventListener() {}, removeEventListener() {},
    moveTo(x, y) { moves.push([x, y]); this.screenX = x; this.screenY = y; },
  };
  const document = {
    readyState: 'complete',
    getElementById: id => elements.get(id),
    createElementNS: () => ({ setAttribute() {}, remove() {} }),
  };
  vm.runInNewContext(code, {
    window, document,
    location: { href: 'chrome://global/content/pictureinpicture/player.xhtml' },
    ChromeUtils: { importESModule: () => ({ PictureInPicture: {
      weakWinToBrowser: new Map([[window, { currentURI: { displayHost: 'example.com' } }]]),
    } }) },
  });
  const fire = (type, x, y, interactive = false) => handlers.get(type)?.({
    type, button: 0, pointerId: 1, screenX: x, screenY: y,
    target: { closest: () => interactive }, preventDefault() {},
  });
  return { window, moves, fire, handlers, captured };
}

test('drag detaches freely and snaps to the bottom right only after release', () => {
  const p = player();
  p.fire('pointerdown', 600, 350);
  p.fire('pointermove', 1100, 700);
  assert.deepEqual(p.moves, [[1000, 650]]);
  p.fire('pointerup', 1100, 700);
  assert.deepEqual(p.moves.at(-1), [1024, 659]);
  p.fire('pointerdown', 1100, 700);
  p.fire('pointermove', 800, 500);
  p.fire('pointerup', 800, 500);
  assert.deepEqual(p.moves.at(-1), [724, 459]);
});

test('all four corners use the current monitor work area, including negative coordinates', () => {
  for (const [x, y] of [[-1424, -884], [-416, -884], [-1424, -241], [-416, -241]]) {
    const p = player({ left: -900, top: -500, screenLeft: -1440, screenTop: -900 });
    p.fire('pointerdown', 0, 0);
    p.fire('pointermove', x + 900 + 20, y + 500 + 20);
    p.fire('pointerup', 0, 0);
    assert.deepEqual(p.moves.at(-1), [x, y]);
  }
});

test('proximity to one edge alone does not pull the window into a corner', () => {
  const p = player();
  p.fire('pointerdown', 0, 0);
  p.fire('pointermove', -480, 0);
  p.fire('pointerup', 0, 0);
  assert.deepEqual(p.moves, [[20, 300]]);
});

test('buttons, fullscreen and a cancelled gesture never snap; unload releases capture', () => {
  const p = player();
  p.fire('pointerdown', 0, 0, true);
  p.fire('pointermove', 500, 350);
  assert.equal(p.moves.length, 0);
  p.window.fullScreen = true;
  p.fire('pointerdown', 0, 0);
  assert.equal(p.captured.size, 0);
  p.window.fullScreen = false;
  p.fire('pointerdown', 0, 0);
  p.fire('pointermove', 500, 350);
  p.fire('pointercancel', 500, 350);
  assert.deepEqual(p.moves, [[1000, 650]]);
  p.fire('pointerdown', 0, 0);
  p.window.arcPictureInPicture.destroy();
  assert.equal(p.handlers.size, 0);
  assert.equal(p.captured.size, 0);
});
