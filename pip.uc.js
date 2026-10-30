// ==UserScript==
// @name           Arc Picture in Picture
// @version        1.3.4
// @description    Arc-inspired controls for Zen's native video player.
// @include        chrome://browser/content/browser.xhtml
// @include        chrome://global/content/pictureinpicture/player.xhtml
// ==/UserScript==

(() => {
  "use strict";
  const MAIN = "chrome://browser/content/browser.xhtml";
  const PIP = "chrome://global/content/pictureinpicture/player.xhtml";
  if (![MAIN, PIP].includes(location.href)) return;
  window.arcPictureInPicture?.destroy();
  const { PictureInPicture } = ChromeUtils.importESModule(
    "moz-src:///toolkit/components/pictureinpicture/PictureInPicture.sys.mjs"
  );
  const cleanups = [];
  const controller = {
    destroy() {
      for (const cleanup of cleanups.splice(0).reverse()) cleanup();
      if (window.arcPictureInPicture === controller) delete window.arcPictureInPicture;
    },
  };
  window.arcPictureInPicture = controller;
  window.addEventListener("unload", controller.destroy, { once: true });
  cleanups.push(() => window.removeEventListener("unload", controller.destroy));
  if (typeof window.addUnloadListener === "function") window.addUnloadListener(controller.destroy);

  if (location.href === MAIN) {
    // One preference owner across all browser windows. Last owner restores the
    // exact original user values, including absence of a user preference.
    const key = "__arcPipPreferences";
    if (!PictureInPicture[key]) {
      const prefs = Services.prefs;
      const auto = "zen.mods.arc-pip.auto";
      const native = [
        "media.videocontrols.picture-in-picture.enabled",
        "media.videocontrols.picture-in-picture.enable-when-switching-tabs.enabled",
        "media.videocontrols.picture-in-picture.enable-when-occluded.enabled",
        "media.videocontrols.picture-in-picture.playback-speed.enabled",
        "media.videocontrols.picture-in-picture.improved-video-controls.enabled",
      ];
      const saved = native.map(name => ({
        name, hasUser: prefs.prefHasUserValue(name), value: prefs.getBoolPref(name, false),
      }));
      const state = {
        owners: new Set(),
        observe() {
          const enabled = prefs.getBoolPref(auto, false);
          native.forEach((name, i) => prefs.setBoolPref(name, (i === 1 || i === 2) ? enabled : true));
        },
        release(owner) {
          state.owners.delete(owner);
          if (state.owners.size) return;
          prefs.removeObserver(auto, state);
          for (const { name, hasUser, value } of saved) {
            if (hasUser) prefs.setBoolPref(name, value);
            else prefs.clearUserPref(name);
          }
          delete PictureInPicture[key];
        },
      };
      PictureInPicture[key] = state;
      prefs.addObserver(auto, state);
      state.observe();
    }
    const state = PictureInPicture[key];
    state.owners.add(controller);
    cleanups.push(() => state.release(controller));
    return;
  }

  function decorate() {
    const controls = document.getElementById("controls");
    if (!controls) return;
    installControlsVisibility(controls);
    installCornerDrag(controls);
    const labels = { unpip: "Back to Tab", minimize: "Minimize", close: "Close" };
    for (const [id, label] of Object.entries(labels)) {
      const button = document.getElementById(id);
      if (!button) continue;
      const span = document.createElementNS("http://www.w3.org/1999/xhtml", "span");
      span.className = "arc-pip-label";
      span.textContent = label;
      // Native click handlers inspect event.target.id: labels must not intercept clicks.
      button.appendChild(span);
      cleanups.push(() => span.remove());
    }
    const domain = document.createElementNS("http://www.w3.org/1999/xhtml", "div");
    domain.id = "arc-pip-domain";
    domain.className = "control-item";
    domain.setAttribute("aria-hidden", "true");
    controls.appendChild(domain);
    cleanups.push(() => domain.remove());
    // The native source mapping is assigned after the player window loads.
    let attempts = 0;
    const updateDomain = () => {
      const source = PictureInPicture.weakWinToBrowser.get(window);
      try { domain.textContent = source?.currentURI?.displayHost || ""; } catch {}
      return Boolean(source) || ++attempts >= 40;
    };
    if (!updateDomain()) {
      const timer = window.setInterval(() => {
        if (updateDomain()) window.clearInterval(timer);
      }, 250);
      cleanups.push(() => window.clearInterval(timer));
    }
  }

  function installControlsVisibility(controls) {
    let timer = null;
    let hovered = controls.matches(":hover");
    function cancel() {
      if (timer !== null) window.clearTimeout(timer);
      timer = null;
    }
    function scheduleHide() {
      cancel();
      timer = window.setTimeout(() => {
        timer = null;
        controls.setAttribute("arc-pip-ui", "hidden");
      }, 3000);
    }
    function show() {
      cancel();
      controls.setAttribute("arc-pip-ui", "visible");
      if (!hovered) scheduleHide();
    }
    const enter = () => { hovered = true; show(); };
    const leave = () => { hovered = false; scheduleHide(); };
    const listeners = [["pointerenter", enter], ["pointerleave", leave], ["focusin", show], ["keydown", show]];
    for (const [type, handler] of listeners) controls.addEventListener(type, handler);
    show();
    cleanups.push(() => {
      cancel();
      controls.removeAttribute("arc-pip-ui");
      for (const [type, handler] of listeners) controls.removeEventListener(type, handler);
    });
  }

  function installCornerDrag(controls) {
    const GAP = 16;
    const RADIUS = 80;
    let drag = null;
    let wheelTimer = null;
    let gesture = null;
    let flight = null;
    const unavailable = () => window.fullScreen || document.fullscreenElement || window.windowState === 2;
    const corners = () => {
      const { availLeft: left, availTop: top, availWidth: width, availHeight: height } = window.screen;
      // All coordinates are CSS screen pixels, as expected by chrome moveTo.
      if (![left, top, width, height, window.outerWidth, window.outerHeight].every(Number.isFinite)) return;
      if (window.outerWidth + GAP * 2 > width || window.outerHeight + GAP * 2 > height) return;
      const xs = [left + GAP, left + width - window.outerWidth - GAP];
      const ys = [top + GAP, top + height - window.outerHeight - GAP];
      return { xs, ys };
    };
    const snap = () => {
      if (unavailable()) return;
      const bounds = corners();
      if (!bounds) return;
      const { xs, ys } = bounds;
      const x = xs.reduce((a, b) => Math.abs(window.screenX - a) <= Math.abs(window.screenX - b) ? a : b);
      const y = ys.reduce((a, b) => Math.abs(window.screenY - a) <= Math.abs(window.screenY - b) ? a : b);
      // Only corners attract: being close to just one edge is insufficient.
      if (Math.abs(window.screenX - x) <= RADIUS && Math.abs(window.screenY - y) <= RADIUS) {
        window.moveTo(x, y);
      }
    };
    function stopFlight() {
      if (flight !== null) window.cancelAnimationFrame(flight.frame);
      flight = null;
    }
    function flyTo(x, y) {
      stopFlight();
      if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
        window.moveTo(x, y);
        return;
      }
      const startX = window.screenX;
      const startY = window.screenY;
      if (startX === x && startY === y) return;
      const started = window.performance.now();
      flight = { frame: null, x, y };
      const tick = now => {
        if (unavailable()) { stopFlight(); return; }
        const progress = Math.min(1, Math.max(0, (now - started) / 340));
        // Asymmetric Beta(3,5) easing: short smooth acceleration, fast travel,
        // then a longer soft landing. Velocity and acceleration are zero
        // at both ends; no spring overshoot or final position correction.
        const eased = progress ** 3 * (35 + progress * (-105 + progress * (126 + progress * (-70 + 15 * progress))));
        window.moveTo(Math.round(startX + (x - startX) * eased), Math.round(startY + (y - startY) * eased));
        if (progress < 1) flight.frame = window.requestAnimationFrame(tick);
        else flight = null;
      };
      flight.frame = window.requestAnimationFrame(tick);
    }
    const down = event => {
      if (event.button !== 0 || unavailable() || drag) return;
      cancelWheel();
      stopFlight();
      if (event.target.closest("button, input, a, .panel, #timestamp")) return;
      drag = {
        id: event.pointerId, x: event.screenX, y: event.screenY,
        left: window.screenX, top: window.screenY, moved: false,
      };
      try { controls.setPointerCapture(event.pointerId); } catch { drag = null; return; }
      event.preventDefault();
    };
    const move = event => {
      if (!drag || event.pointerId !== drag.id) return;
      const dx = event.screenX - drag.x;
      const dy = event.screenY - drag.y;
      if (!drag.moved && Math.hypot(dx, dy) < 4) return;
      drag.moved = true;
      // Do not magnetize during a held drag, even when it crosses a corner.
      window.moveTo(Math.round(drag.left + dx), Math.round(drag.top + dy));
      event.preventDefault();
    };
    const finish = event => {
      if (!drag || event.pointerId !== drag.id) return;
      const { id, moved } = drag;
      drag = null;
      if (controls.hasPointerCapture(id)) controls.releasePointerCapture(id);
      if (moved && event.type === "pointerup") snap();
    };
    function cancelWheel() {
      if (wheelTimer !== null) window.clearTimeout(wheelTimer);
      wheelTimer = null;
      gesture = null;
    }
    const wheel = event => {
      if (drag || unavailable() || event.ctrlKey || event.metaKey || event.altKey) return;
      // Sliders and the open speed menu keep their own scrolling behavior.
      if (event.target.closest("input, .panel")) return;
      const scaleX = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? window.innerWidth : 1;
      const scaleY = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? window.innerHeight : 1;
      const dx = event.deltaX * scaleX;
      const dy = event.deltaY * scaleY;
      if (!Number.isFinite(dx) || !Number.isFinite(dy) || (!dx && !dy)) return;
      const bounds = corners();
      if (!bounds) return;
      event.preventDefault();
      event.stopPropagation();
      gesture ??= { x: 0, y: 0, fired: false };
      // Accumulate small deltas to reject accidental touches, then choose one
      // direction. Inertia belongs to that same swipe and cannot retrigger it.
      gesture.x -= dx;
      gesture.y -= dy;
      if (!gesture.fired && Math.max(Math.abs(gesture.x), Math.abs(gesture.y)) >= 24) {
        gesture.fired = true;
        const { xs, ys } = bounds;
        const baseX = flight?.x ?? window.screenX;
        const baseY = flight?.y ?? window.screenY;
        let x = Math.abs(baseX - xs[0]) <= Math.abs(baseX - xs[1]) ? xs[0] : xs[1];
        let y = Math.abs(baseY - ys[0]) <= Math.abs(baseY - ys[1]) ? ys[0] : ys[1];
        if (Math.abs(gesture.x) > Math.abs(gesture.y)) x = gesture.x < 0 ? xs[0] : xs[1];
        else y = gesture.y < 0 ? ys[0] : ys[1];
        flyTo(x, y);
      }
      if (wheelTimer !== null) window.clearTimeout(wheelTimer);
      // Wait for the entire momentum stream to stop before accepting a new swipe.
      wheelTimer = window.setTimeout(() => {
        wheelTimer = null;
        gesture = null;
      }, 220);
    };
    const listeners = [
      ["pointerdown", down], ["pointermove", move],
      ["pointerup", finish], ["pointercancel", finish], ["lostpointercapture", finish],
    ];
    for (const [type, listener] of listeners) controls.addEventListener(type, listener);
    controls.addEventListener("wheel", wheel, { passive: false });
    cleanups.push(() => {
      cancelWheel();
      stopFlight();
      controls.removeEventListener("wheel", wheel);
      for (const [type, listener] of listeners) controls.removeEventListener(type, listener);
      if (drag && controls.hasPointerCapture(drag.id)) controls.releasePointerCapture(drag.id);
      drag = null;
    });
  }
  if (document.readyState === "loading") {
    window.addEventListener("DOMContentLoaded", decorate, { once: true });
    cleanups.push(() => window.removeEventListener("DOMContentLoaded", decorate));
  } else decorate();
})();
