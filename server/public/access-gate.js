(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const shell = $('libraryShell'), dialog = $('accessDialog'), preloader = $('accessPreloader');
  if (!shell || !dialog || !preloader) return;
  const startedAt = performance.now(), requests = new Set(), waiters = new Set();
  let verified = false, expiresAt = 0, generation = 0, expiryTimer = null;
  let challenge = null, busy = false, imageReady = false, challengeGeneration = 0, statusGeneration = 0;
  let challengeController = null, verifyController = null, retryUntil = 0, retryTimer = null, statusRequest = null;
  let bootFinished = false, firstUnlock, channel = null;
  const ready = new Promise(resolve => { firstUnlock = resolve; });
  const accessError = () => Object.assign(new Error('Complete the verification to continue.'), { name: 'AccessRequiredError' });
  const formatDelay = () => Math.max(0, Math.ceil((retryUntil - Date.now()) / 1000));
  const emit = () => window.dispatchEvent(new CustomEvent('civitai-access-change', { detail: { verified, expiresAt, generation } }));
  function notifyTabs() { try { channel?.postMessage({ type: 'access-changed' }); } catch {} }
  function message(text = '', error = false) {
    $('accessMessage').textContent = text; $('accessMessage').classList.toggle('is-error', error);
  }
  function controls() {
    const delayed = formatDelay() > 0;
    $('accessAnswer').disabled = busy || !imageReady || delayed;
    $('accessSubmit').disabled = busy || !imageReady || delayed;
    $('accessRefresh').disabled = busy || delayed;
    $('accessRetry').disabled = busy || delayed;
    $('accessSubmit').textContent = busy ? 'Checking…' : 'Enter the library';
    $('accessForm').setAttribute('aria-busy', String(busy));
  }
  function showDialog() {
    preloader.hidden = true;
    if (!dialog.open) {
      if (typeof dialog.showModal === 'function') dialog.showModal();
      else { dialog.setAttribute('open', ''); dialog.setAttribute('role', 'dialog'); dialog.setAttribute('aria-modal', 'true'); }
    }
    if (!dialog.contains(document.activeElement)) (imageReady && !busy ? $('accessAnswer') : $('accessTitle')).focus({ preventScroll: true });
  }
  function setLockedAppearance() {
    document.documentElement.classList.add('access-locked');
    shell.inert = true; shell.setAttribute('aria-hidden', 'true');
  }
  function lock(reason = '', loadChallenge = true) {
    const changed = verified;
    verified = false; expiresAt = 0; generation++;
    clearTimeout(expiryTimer); expiryTimer = null;
    for (const controller of requests) controller.abort();
    requests.clear();
    setLockedAppearance();
    emit();
    if (bootFinished) {
      $('accessDescription').textContent = reason || 'A quick check before you explore the image library.';
      showDialog();
      if (loadChallenge && !busy && !challenge) newChallenge();
    }
    return changed;
  }
  function isVerified() {
    if (verified && Date.now() >= expiresAt) {
      lock('Your hour of access has ended. Complete a new check to continue.'); notifyTabs();
    }
    return verified;
  }
  function unlock(value) {
    const expiry = Number(value?.expiresAt);
    if (value?.verified !== true || !Number.isFinite(expiry) || expiry <= Date.now()) return false;
    const changed = !verified;
    verified = true; expiresAt = expiry;
    clearTimeout(expiryTimer);
    expiryTimer = setTimeout(() => { if (!isVerified()) refreshStatus(); }, Math.min(2147483647, Math.max(1, expiry - Date.now() + 20)));
    challengeGeneration++; challengeController?.abort(); verifyController?.abort();
    challenge = null; busy = false; imageReady = false;
    $('accessImage').removeAttribute('src'); $('accessAnswer').value = '';
    $('accessRetry').hidden = true; message();
    preloader.hidden = true;
    if (dialog.open) typeof dialog.close === 'function' ? dialog.close() : dialog.removeAttribute('open');
    shell.inert = false; shell.removeAttribute('aria-hidden');
    document.documentElement.classList.remove('access-locked');
    firstUnlock?.(true); firstUnlock = null;
    for (const resolve of waiters) resolve(true);
    waiters.clear();
    if (changed) { emit(); $('query')?.focus({ preventScroll: true }); }
    return true;
  }
  function retryAfter(response) {
    const value = response.headers.get('Retry-After') || '';
    const seconds = /^\d+$/.test(value) ? Number(value) : Math.ceil((Date.parse(value) - Date.now()) / 1000);
    return Math.min(3600, Math.max(1, Number.isFinite(seconds) ? seconds : 30));
  }
  function beginCooldown(seconds) {
    retryUntil = Date.now() + seconds * 1000;
    clearInterval(retryTimer);
    const tick = () => {
      const remaining = formatDelay();
      if (remaining) message(`Please wait ${remaining}s before trying again.`, true);
      else { clearInterval(retryTimer); retryTimer = null; message('You can try again now.'); }
      controls();
    };
    tick(); retryTimer = setInterval(tick, 1000);
  }
  async function accessRequest(action, options = {}) {
    const controller = options.controller || new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch(`access.php?action=${action}`, {
        method: options.body ? 'POST' : 'GET', credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: controller.signal,
        headers: { Accept: 'application/json', ...(options.body ? { 'Content-Type': 'application/json' } : {}) },
        ...(options.body ? { body: JSON.stringify(options.body) } : {})
      });
      const data = await response.json().catch(() => null);
      if (!response.ok || !data?.ok) {
        const failure = new Error(data?.error || 'Verification is temporarily unavailable. Please try again.');
        failure.status = response.status;
        if (response.status === 429) failure.retryAfter = retryAfter(response);
        throw failure;
      }
      return data;
    } finally { clearTimeout(timeout); }
  }
  function challengeImageUrl(value, id) {
    try {
      const url = new URL(value, location.href), expected = new URL('access.php', location.href);
      return url.origin === expected.origin && url.pathname === expected.pathname && url.searchParams.get('action') === 'image' && url.searchParams.get('id') === String(id) ? url.href : '';
    } catch { return ''; }
  }
  async function newChallenge(keepMessage = false) {
    if (isVerified() || busy || formatDelay()) return;
    const ticket = ++challengeGeneration;
    challengeController?.abort(); challengeController = new AbortController();
    challenge = null; imageReady = false; busy = true; $('accessAnswer').value = '';
    $('accessImage').removeAttribute('src'); $('accessImage').hidden = true;
    $('accessImagePlaceholder').hidden = false; $('accessImagePlaceholder').textContent = 'Preparing your code…';
    $('accessRetry').hidden = true;
    if (!keepMessage) message();
    controls();
    try {
      const data = await accessRequest('challenge', { controller: challengeController });
      if (ticket !== challengeGeneration || verified) return;
      if (data.verified === true) { if (!unlock(data)) throw new Error('Please try verification again.'); return; }
      const imageUrl = challengeImageUrl(data.imageUrl, data.challengeId);
      if (!imageUrl || !data.challengeId || typeof data.csrfToken !== 'string' || !data.csrfToken || Number(data.length) !== 6 || !Number.isFinite(Number(data.expiresAt)) || Number(data.expiresAt) <= Date.now()) throw new Error('Could not prepare a verification code. Please try again.');
      challenge = data;
      const image = $('accessImage');
      image.onload = () => {
        if (ticket !== challengeGeneration || verified) return;
        imageReady = true; image.hidden = false; $('accessImagePlaceholder').hidden = true;
        controls(); $('accessAnswer').focus({ preventScroll: true });
      };
      image.onerror = () => {
        if (ticket !== challengeGeneration || verified) return;
        imageReady = false; challenge = null; image.hidden = true;
        $('accessImagePlaceholder').textContent = 'Code unavailable';
        message('The verification image could not load. Please try again.', true); $('accessRetry').hidden = false; controls();
      };
      image.src = imageUrl;
    } catch (error) {
      if (ticket !== challengeGeneration || verified) return;
      $('accessImagePlaceholder').textContent = 'Code unavailable'; $('accessRetry').hidden = false;
      if (error.retryAfter) beginCooldown(error.retryAfter);
      else message(error.name === 'AbortError' ? 'The check took too long. Please try again.' : error.message, true);
    } finally { if (ticket === challengeGeneration && !verified) { busy = false; controls(); } }
  }
  async function verify(event) {
    event.preventDefault();
    if (busy || !imageReady || !challenge || formatDelay()) return;
    if (Number(challenge.expiresAt) <= Date.now()) { message('This code has expired. Try the new one below.', true); await newChallenge(true); return; }
    const answer = $('accessAnswer').value.trim();
    if (answer.length !== 6) { message('Enter all six characters shown in the image.', true); $('accessAnswer').focus(); return; }
    busy = true; controls(); message('Checking your code…');
    const ticket = challengeGeneration, current = challenge;
    verifyController = new AbortController();
    try {
      const data = await accessRequest('verify', { controller: verifyController, body: { challengeId: current.challengeId, csrfToken: current.csrfToken, answer } });
      if (ticket !== challengeGeneration) return;
      // A status response issued before this solve cannot revoke its success.
      statusGeneration++;
      if (!unlock(data)) throw new Error('Please try verification again.');
      notifyTabs();
    } catch (error) {
      if (ticket !== challengeGeneration || verified) return;
      busy = false;
      if (error.retryAfter) { beginCooldown(error.retryAfter); $('accessRetry').hidden = false; }
      else if (error.status === 400 || error.status === 403 || error.status === 409 || error.status === 410) { message(error.message || 'That code did not match. Please try the new code.', true); await newChallenge(true); }
      else { message(error.name === 'AbortError' ? 'The check took too long. Please try again.' : error.message, true); $('accessRetry').hidden = false; }
    } finally { if (ticket === challengeGeneration && !verified) { busy = false; controls(); } }
  }
  async function refreshStatus() {
    if (statusRequest) return statusRequest;
    const ticket = ++statusGeneration;
    const pending = (async () => {
      try {
        const data = await accessRequest('status');
        if (ticket !== statusGeneration) return;
        if (data.verified === true) { if (!unlock(data)) lock('Complete a new check to continue browsing.'); }
        else lock(verified ? 'Complete a new check to continue browsing.' : '', true);
      } catch (error) {
        if (ticket !== statusGeneration) return;
        lock('We could not confirm your access. Please try again.', false);
        if (error.retryAfter) beginCooldown(error.retryAfter);
        else message(error.name === 'AbortError' ? 'The connection took too long. Please try again.' : error.message, true);
        $('accessRetry').hidden = false; controls();
      } finally { if (statusRequest === pending) statusRequest = null; }
    })();
    statusRequest = pending;
    return pending;
  }
  async function protectedFetch(input, init = {}) {
    if (!isVerified()) throw accessError();
    const url = new URL(input, location.href);
    if (url.origin !== location.origin) throw new Error('Only library requests are allowed.');
    const ticket = generation, controller = new AbortController();
    const abort = () => controller.abort();
    if (init.signal?.aborted) abort(); else init.signal?.addEventListener('abort', abort, { once: true });
    requests.add(controller);
    let timedOut = false;
    const timeout = setTimeout(() => { timedOut = true; abort(); }, 60000);
    try {
      const response = await fetch(url, { ...init, credentials: 'same-origin', cache: 'no-store', signal: controller.signal });
      const body = await response.arrayBuffer();
      if (ticket !== generation || !isVerified()) throw accessError();
      if (response.status === 403 || response.status === 401) {
        let denied;
        try { denied = JSON.parse(new TextDecoder().decode(body)); } catch {}
        if (['captcha_required', 'access_required'].includes(denied?.code) || denied?.captchaRequired === true) {
          lock('Complete a new check to continue browsing.'); throw accessError();
        }
      }
      return new Response([204, 205, 304].includes(response.status) ? null : body, { status: response.status, statusText: response.statusText, headers: response.headers });
    } catch (error) {
      // A deadline must render the caller's error/Retry UI. Navigation and a
      // locked session still use their existing silent-cancellation behavior.
      if (timedOut) throw Object.assign(new Error('The request timed out after 60 seconds. Please try again.'), { name: 'RequestTimeoutError' });
      throw error;
    } finally { clearTimeout(timeout); requests.delete(controller); init.signal?.removeEventListener('abort', abort); }
  }
  function ensureAccess() {
    if (isVerified()) return Promise.resolve(true);
    if (bootFinished) showDialog();
    return new Promise(resolve => waiters.add(resolve));
  }
  window.CivitaiAccess = Object.freeze({ ready, ensureAccess, isVerified, fetch: protectedFetch, refresh: refreshStatus, get generation() { return generation; } });
  $('accessForm').addEventListener('submit', verify);
  $('accessRefresh').addEventListener('click', () => newChallenge());
  $('accessRetry').addEventListener('click', () => { if (!formatDelay()) { challenge = null; newChallenge(); } });
  dialog.addEventListener('cancel', event => event.preventDefault());
  dialog.addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); }
    if (event.key !== 'Tab') return;
    const nodes = [...dialog.querySelectorAll('button,input,a[href]')].filter(node => !node.disabled && !node.hidden && node.getClientRects().length);
    const first = nodes[0], last = nodes.at(-1);
    if (!first) { event.preventDefault(); $('accessTitle').focus(); }
    else if (event.shiftKey && (document.activeElement === first || !nodes.includes(document.activeElement))) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && (document.activeElement === last || !nodes.includes(document.activeElement))) { event.preventDefault(); first.focus(); }
  });
  document.addEventListener('visibilitychange', () => { if (!document.hidden && bootFinished) { isVerified(); refreshStatus(); } });
  window.addEventListener('pagehide', () => {
    statusGeneration++; statusRequest = null; challengeGeneration++;
    challengeController?.abort(); verifyController?.abort(); challenge = null; busy = false; imageReady = false;
    lock('', false);
  });
  window.addEventListener('pageshow', event => { if (event.persisted && bootFinished) refreshStatus(); });
  try { channel = new BroadcastChannel('civitai-library-access'); channel.onmessage = event => { if (event.data?.type === 'access-changed' && bootFinished) refreshStatus(); }; } catch {}
  async function boot() {
    setLockedAppearance(); controls();
    const domReady = document.readyState === 'loading' ? new Promise(resolve => document.addEventListener('DOMContentLoaded', resolve, { once: true })) : Promise.resolve();
    let initial, failure;
    await Promise.all([domReady, new Promise(resolve => setTimeout(resolve, Math.max(0, 450 - (performance.now() - startedAt)))), accessRequest('status').then(value => { initial = value; }, error => { failure = error; })]);
    bootFinished = true;
    if (initial?.verified === true && unlock(initial)) return;
    lock('', false); showDialog();
    if (failure) { if (failure.retryAfter) beginCooldown(failure.retryAfter); else message(failure.name === 'AbortError' ? 'The connection took too long. Please try again.' : failure.message, true); $('accessRetry').hidden = false; }
    else await newChallenge();
  }
  boot();
})();
