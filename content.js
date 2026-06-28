/**
 * YouTube Preview Speed – content.js
 *
 * Injects a native-looking speed badge beside the Mute/CC buttons inside
 * YouTube's inline hover-preview player (#inline-preview-player).
 *
 * Key findings from research that drive the implementation:
 *  - DO NOT search for <video> elements directly — too many false positives.
 *  - Use capture-phase "play" on document, then confirm via #inline-preview-player.
 *  - .ytp-overlay-bottom-right has pointer-events:none — wrapper must override it.
 *  - YouTube resets playbackRate; reapply on playing/loadeddata/canplay/ratechange.
 *  - Dropdown is inside the wrapper (inside the player) so mouse stays in hover area.
 *  - Full cleanup on preview end — no orphaned nodes or listeners.
 */
(function yps() {
  'use strict';

  // ── Config ────────────────────────────────────────────────────────────────

  const SPEEDS    = [0.5, 1, 1.5, 2];
  const KEY       = 'yps_speed';
  const PLAYER_ID = 'inline-preview-player';

  // Events on which YouTube may silently reset playbackRate
  const REAPPLY_EVENTS = ['playing', 'loadeddata', 'canplay', 'ratechange'];

  // ── State ─────────────────────────────────────────────────────────────────

  let savedSpeed     = 1;
  let currentVideo   = null;
  let badgeEl        = null;
  let dropdownEl     = null;
  let dropdownOpen   = false;
  let outsideHandler = null;
  let pauseTimer     = null;
  let pendingCleanup = false; // true when preview ended while dropdown was open

  // Flat list of {video, type, fn} so cleanup is O(n) with no closures leaking
  const listeners = [];

  // ── Boot ──────────────────────────────────────────────────────────────────

  chrome.storage.local.get([KEY], (res) => {
    savedSpeed = typeof res[KEY] === 'number' ? res[KEY] : 1;
  });

  // Capture phase fires before YouTube's own handlers on every video element.
  // This is the only global listener the extension registers.
  document.addEventListener('play', onAnyPlay, true);

  // ── Play detection ────────────────────────────────────────────────────────

  function onAnyPlay(e) {
    if (!(e.target instanceof HTMLVideoElement)) return;

    // #inline-preview-player is only present while a hover preview is active
    const player = document.getElementById(PLAYER_ID);
    if (!player || !player.contains(e.target)) return;

    // Same video is already set up (e.g. it looped)
    if (e.target === currentVideo) return;

    setupPreview(e.target, player);
  }

  // ── Preview setup ─────────────────────────────────────────────────────────

  function setupPreview(video, player) {
    // Always clean up any previous preview first
    cleanup();

    currentVideo = video;
    setRate(savedSpeed);

    injectBadge(player);

    bindVideoEvents(video);
  }

  function bindVideoEvents(video) {
    // Re-apply speed if YouTube resets it (checked against savedSpeed to avoid
    // infinite ratechange → setRate → ratechange cycles)
    REAPPLY_EVENTS.forEach((type) => {
      const fn = () => {
        if (video.playbackRate !== savedSpeed) setRate(savedSpeed);
      };
      video.addEventListener(type, fn);
      listeners.push({ video, type, fn });
    });

    // Detect end of preview.  500 ms debounce avoids false positives from
    // brief buffering pauses.
    const pauseFn = () => {
      clearTimeout(pauseTimer);
      pauseTimer = setTimeout(() => {
        if (currentVideo === video && video.paused) cleanup();
      }, 500);
    };
    video.addEventListener('pause', pauseFn);
    listeners.push({ video, type: 'pause', fn: pauseFn });
  }

  // ── Cleanup ───────────────────────────────────────────────────────────────

  function cleanup() {
    closeDropdown();

    clearTimeout(pauseTimer);
    pauseTimer = null;

    listeners.forEach(({ video, type, fn }) => video.removeEventListener(type, fn));
    listeners.length = 0;

    // Remove wrapper (badge's parent) so nothing is left in the YouTube DOM
    badgeEl?.parentElement?.remove();
    badgeEl = null;
    currentVideo = null;
  }

  // ── Badge ─────────────────────────────────────────────────────────────────

  function injectBadge(player) {
    // Prevent duplicates on rapid hover
    if (player.querySelector('.yps-badge')) return;

    // Guarantee the player is a positioning context so our absolute wrapper
    // is relative to it, not some higher ancestor
    if (getComputedStyle(player).position === 'static') {
      player.style.position = 'relative';
    }

    const wrapper = document.createElement('div');
    wrapper.className = 'yps-wrapper';

    // YouTube's SPA router and video-click handler listen to mousedown/pointerdown
    // in addition to click.  Block all three on the wrapper so nothing propagates
    // to the <a> tag or overlay beneath — without touching YouTube's own listeners.
    ['mousedown', 'pointerdown', 'click'].forEach((type) => {
      wrapper.addEventListener(type, (e) => {
        e.stopPropagation();
        e.preventDefault();
      });
    });

    badgeEl = document.createElement('button');
    badgeEl.className = 'yps-badge';
    badgeEl.setAttribute('aria-haspopup', 'listbox');
    syncBadge();

    // Badge click fires on the target (badgeEl) before bubbling to wrapper,
    // so this handler runs even though the wrapper also blocks click propagation.
    badgeEl.addEventListener('click', () => {
      dropdownOpen ? closeDropdown() : openDropdown();
    });

    wrapper.appendChild(badgeEl);
    player.appendChild(wrapper);
  }

  function syncBadge() {
    if (!badgeEl) return;
    const label = fmt(savedSpeed);
    badgeEl.textContent = `${label} ▾`;
    badgeEl.setAttribute('aria-label', `Preview speed: ${label}. Click to change.`);
  }

  // ── Dropdown ──────────────────────────────────────────────────────────────

  function openDropdown() {
    if (dropdownOpen || !badgeEl) return;
    dropdownOpen = true;

    dropdownEl = document.createElement('div');
    dropdownEl.className = 'yps-dropdown';
    dropdownEl.setAttribute('role', 'listbox');
    dropdownEl.setAttribute('aria-label', 'Preview playback speed');

    SPEEDS.forEach((spd) => {
      const btn = document.createElement('button');
      const active = spd === savedSpeed;
      btn.className = 'yps-item' + (active ? ' yps-item--active' : '');
      btn.setAttribute('role', 'option');
      btn.setAttribute('aria-selected', String(active));
      btn.innerHTML = `<span class="yps-check" aria-hidden="true">${active ? '✓' : ''}</span>${fmt(spd)}`;

      btn.addEventListener('click', () => pick(spd));

      dropdownEl.appendChild(btn);
    });

    // Append inside the wrapper — NOT document.body.
    //
    // Previously on body (position:fixed), moving the mouse from the badge to
    // the dropdown left the thumbnail hover area, causing YouTube to restart
    // the preview.  Being inside the wrapper means the mouse stays within
    // #inline-preview-player the whole time.
    //
    // The wrapper already blocks mousedown/pointerdown/click from bubbling up,
    // so no separate blockers are needed on the dropdown.
    badgeEl.parentElement.appendChild(dropdownEl);

    // Close when the user clicks anywhere outside the wrapper
    outsideHandler = (e) => {
      if (!badgeEl?.parentElement?.contains(e.target)) {
        closeDropdown();
      }
    };
    document.addEventListener('pointerdown', outsideHandler, true);
  }

  function closeDropdown() {
    if (!dropdownOpen) return;
    dropdownOpen = false;

    if (outsideHandler) {
      document.removeEventListener('pointerdown', outsideHandler, true);
      outsideHandler = null;
    }

    dropdownEl?.remove();
    dropdownEl = null;
  }

  function pick(spd) {
    savedSpeed = spd;
    chrome.storage.local.set({ [KEY]: spd });
    setRate(spd);
    syncBadge();
    closeDropdown();
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  function setRate(spd) {
    if (currentVideo) currentVideo.playbackRate = spd;
  }

  function fmt(spd) {
    return `${spd}\u00D7`; // e.g. "1.5×"
  }

})();
