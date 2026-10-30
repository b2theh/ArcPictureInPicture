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
  assert.equal(env.values.get(ROOT + 'playback-speed.enabled'), true);
  assert.equal(env.values.get(ROOT + 'improved-video-controls.enabled'), true);
  env.prefs.setBoolPref(AUTO, true);
  assert.equal(env.values.get(ROOT + 'enable-when-switching-tabs.enabled'), true);
  assert.equal(env.values.get(ROOT + 'enable-when-occluded.enabled'), true);
  env.prefs.setBoolPref(AUTO, false);
  assert.equal(env.values.get(ROOT + 'enable-when-switching-tabs.enabled'), false);
  win.close();
  assert.equal(env.values.has(ROOT + 'enabled'), false);
  assert.equal(env.values.has(ROOT + 'playback-speed.enabled'), false);
  assert.equal(env.observers.size, 0);
});

test('multiple windows retain overrides until the last owner leaves, then restore exact user preferences', () => {
  const initial = {
    [AUTO]: true, [ROOT + 'enabled']: false, [ROOT + 'enable-when-occluded.enabled']: true,
    [ROOT + 'playback-speed.enabled']: false, [ROOT + 'improved-video-controls.enabled']: false,
  };
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

function player({ left = 500, top = 300, screenLeft = 0, screenTop = 0, hovered = true } = {}) {
  const handlers = new Map();
  const captured = new Set();
  const moves = [];
  const timers = new Map();
  const frames = new Map();
  let now = 0;
  let nextTimer = 0;
  const attributes = new Map();
  const controls = {
    matches: () => hovered,
    setAttribute: (name, value) => attributes.set(name, value),
    removeAttribute: name => attributes.delete(name),
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
    innerWidth: 400, innerHeight: 225,
    screen: { availLeft: screenLeft, availTop: screenTop, availWidth: 1440, availHeight: 900 },
    addEventListener() {}, removeEventListener() {},
    moveTo(x, y) { moves.push([x, y]); this.screenX = x; this.screenY = y; },
    setTimeout(cb, delay) { const id = ++nextTimer; timers.set(id, { cb, due: now + delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    performance: { now: () => now },
    matchMedia: () => ({ matches: false }),
    requestAnimationFrame(cb) { const id = ++nextTimer; frames.set(id, cb); return id; },
    cancelAnimationFrame: id => frames.delete(id),
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
  const wheel = (dx, dy, options = {}) => {
    const event = {
      deltaX: dx, deltaY: dy, deltaMode: 0,
      target: { closest: () => false },
      preventDefault() { this.prevented = true; }, stopPropagation() {},
      ...options,
    };
    handlers.get('wheel')?.(event);
    return event;
  };
  const settle = () => {
    const callbacks = [...timers.values()];
    timers.clear();
    for (const { cb } of callbacks) cb();
  };
  const advance = ms => {
    now += ms;
    const callbacks = [...frames.values()];
    frames.clear();
    for (const cb of callbacks) cb(now);
  };
  const elapse = ms => {
    now += ms;
    for (const [id, timer] of [...timers]) {
      if (timer.due <= now) { timers.delete(id); timer.cb(); }
    }
  };
  return { window, moves, fire, handlers, captured, wheel, settle, timers, frames, advance, elapse, attributes };
}

test('drag detaches freely and snaps to the bottom right only after release', () => {
  const p = player();
  p.fire('pointerdown', 600, 350);
  p.fire('pointermove', 1100, 700);
  assert.deepEqual(p.moves, [[1000, 650]]);
  p.fire('pointerup', 1100, 700);
  assert.deepEqual(p.moves, [[1000, 650]], 'no jump on release');
  p.advance(190);
  assert.deepEqual(p.moves.at(-1), [1012, 655]);
  p.advance(190);
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
    p.advance(380);
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

test('manual magnet reaches 160px on each axis, leaves farther positions alone and can be interrupted', () => {
  for (const distance of [120, 160, 161]) {
    const p = player();
    p.fire('pointerdown', 0, 0);
    p.fire('pointermove', 1024 - distance - 500, 659 - distance - 300);
    p.fire('pointerup', 0, 0);
    if (distance <= 160) {
      assert.equal(p.frames.size, 1);
      p.advance(380);
      assert.deepEqual(p.moves.at(-1), [1024, 659]);
    } else {
      assert.equal(p.frames.size, 0);
      assert.deepEqual(p.moves.at(-1), [863, 498]);
    }
  }
  const p = player();
  p.fire('pointerdown', 0, 0);
  p.fire('pointermove', 400, 300);
  p.fire('pointerup', 0, 0);
  p.advance(100);
  p.fire('pointerdown', 0, 0);
  assert.equal(p.frames.size, 0);
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

test('each swipe direction selects the corresponding corner while preserving the other side', () => {
  const cases = [
    [1024, 659, 0, 40, 1024, 16],
    [16, 16, 0, -40, 16, 659],
    [1024, 16, 40, 0, 16, 16],
    [16, 659, -40, 0, 1024, 659],
  ];
  for (const [left, top, dx, dy, x, y] of cases) {
    const p = player({ left, top });
    assert.equal(p.wheel(dx, dy).prevented, true);
    assert.equal(p.moves.length, 0);
    p.advance(260);
    assert.notDeepEqual(p.moves.at(-1), [x, y]);
    p.advance(260);
    assert.deepEqual(p.moves.at(-1), [x, y]);
    assert.equal(p.frames.size, 0);
  }
});

test('a swipe from the center uses the dominant direction and nearest perpendicular side', () => {
  const p = player({ left: 700, top: 400 });
  p.wheel(8, 40);
  p.advance(520);
  assert.deepEqual(p.moves.at(-1), [1024, 16]);
});

test('small touches accumulate to a threshold; a momentum stream triggers one flight', () => {
  const p = player({ left: 1024, top: 659 });
  p.wheel(0, 10);
  p.wheel(0, 10);
  assert.equal(p.frames.size, 0);
  p.wheel(0, 5);
  assert.equal(p.frames.size, 1);
  p.advance(520);
  // A reversed inertia tail must not send the window back down.
  p.wheel(0, -100);
  p.advance(520);
  assert.deepEqual(p.moves, [[1024, 16]]);
  assert.equal(p.timers.size, 1);
  p.settle();
  p.wheel(0, -40);
  p.advance(520);
  assert.deepEqual(p.moves.at(-1), [1024, 659]);
});

test('wheel line/page units and monitors with negative origins choose valid corners', () => {
  const p = player({ left: -416, top: -241, screenLeft: -1440, screenTop: -900 });
  p.wheel(2, 0, { deltaMode: 1 });
  p.advance(520);
  assert.deepEqual(p.moves.at(-1), [-1424, -241]);
  p.settle();
  p.wheel(0, 1, { deltaMode: 2 });
  p.advance(520);
  assert.deepEqual(p.moves.at(-1), [-1424, -884]);
});

test('speed menu, sliders, modifier gestures and fullscreen do not move the window', () => {
  const p = player();
  for (const modifier of ['ctrlKey', 'metaKey', 'altKey']) p.wheel(40, 40, { [modifier]: true });
  p.wheel(40, 40, { target: { closest: () => true } });
  p.window.fullScreen = true;
  p.wheel(40, 40);
  assert.equal(p.frames.size, 0);
  assert.equal(p.moves.length, 0);
});

test('grabbing an animating window stops the flight and continues a free drag', () => {
  const p = player({ left: 1024, top: 659 });
  p.wheel(0, 40);
  p.advance(100);
  const y = p.window.screenY;
  p.fire('pointerdown', 0, 0);
  assert.equal(p.frames.size, 0);
  assert.equal(p.timers.size, 0);
  p.fire('pointermove', -200, 100);
  p.fire('pointerup', -200, 100);
  p.advance(520);
  assert.deepEqual(p.moves.at(-1), [824, y + 100]);
});

test('unload cancels animation and gesture timers; reduced motion moves directly', () => {
  const p = player();
  p.wheel(40, 0);
  p.window.arcPictureInPicture.destroy();
  assert.equal(p.frames.size, 0);
  assert.equal(p.timers.size, 0);
  const reduced = player();
  reduced.window.matchMedia = () => ({ matches: true });
  reduced.wheel(0, 40);
  assert.deepEqual(reduced.moves, [[16, 16]]);
  assert.equal(reduced.frames.size, 0);
});


test('swipe changes speed gradually across the entire path, without a fast-to-slow boundary', () => {
  const p = player({ left: 1024, top: 659 });
  p.wheel(0, 40);
  const positions = [659];
  for (let frame = 0; frame < 20; frame++) {
    p.advance(26);
    positions.push(p.window.screenY);
  }
  const steps = positions.slice(1).map((y, i) => positions[i] - y);
  const peak = Math.max(...steps);
  const peakIndex = steps.indexOf(peak);
  assert.ok(peakIndex >= 6 && peakIndex <= 10, 'broad speed peak near the center of the trip');
  for (let i = 1; i < steps.length; i++) {
    assert.ok(Math.abs(steps[i] - steps[i - 1]) <= peak * 0.3, 'no abrupt change between consecutive samples');
  }
  for (let i = peakIndex + 1; i < steps.length; i++) assert.ok(steps[i] <= steps[i - 1] + 1);
  assert.ok(steps[0] <= 2 && steps.at(-1) <= 2, 'soft start and finish');
  assert.ok(positions.every(y => y >= 16 && y <= 659));
  assert.ok(positions[10] > 100, 'the slow tail does not begin with the window already at its corner');
  assert.deepEqual(p.moves.at(-1), [1024, 16]);
  assert.equal(p.frames.size, 0);
});

test('controls remain visible for three seconds after leaving and hide only at the deadline', () => {
  const p = player();
  p.fire('pointerleave');
  p.elapse(2999);
  assert.equal(p.attributes.get('arc-pip-ui'), 'visible');
  p.elapse(1);
  assert.equal(p.attributes.get('arc-pip-ui'), 'hidden');
  p.fire('pointerenter');
  assert.equal(p.attributes.get('arc-pip-ui'), 'visible');
  assert.equal(p.timers.size, 0);
});

test('returning the cursor cancels hiding and the next leave starts a fresh three seconds', () => {
  const p = player();
  p.fire('pointerleave');
  p.elapse(2000);
  p.fire('pointerenter');
  p.elapse(2000);
  assert.equal(p.attributes.get('arc-pip-ui'), 'visible');
  p.fire('pointerleave');
  p.elapse(2999);
  assert.equal(p.attributes.get('arc-pip-ui'), 'visible');
  p.elapse(1);
  assert.equal(p.attributes.get('arc-pip-ui'), 'hidden');
});

test('opening without hover schedules hiding; keyboard focus reveals controls and unload clears the timer', () => {
  const p = player({ hovered: false });
  p.elapse(3000);
  assert.equal(p.attributes.get('arc-pip-ui'), 'hidden');
  p.fire('focusin');
  assert.equal(p.attributes.get('arc-pip-ui'), 'visible');
  p.elapse(2000);
  p.fire('keydown');
  p.elapse(2000);
  assert.equal(p.attributes.get('arc-pip-ui'), 'visible');
  p.window.arcPictureInPicture.destroy();
  assert.equal(p.timers.size, 0);
  assert.equal(p.attributes.has('arc-pip-ui'), false);
});
