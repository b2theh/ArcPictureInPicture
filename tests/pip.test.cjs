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
