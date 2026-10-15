// A worker supplies collection and scroll pulses even for inactive Civitai tabs.
// The service worker acknowledges each pulse before its network jobs finish.
const clockWorker = new Worker('offscreen-clock.js');
let pulseInFlight = false;

async function pulse() {
  if (pulseInFlight) return;
  pulseInFlight = true;

  try {
    await chrome.runtime.sendMessage({ type: 'driverPulse', source: 'offscreen' });
  } catch {
    // The service worker may be restarting. The next pulse reconnects.
  } finally {
    pulseInFlight = false;
  }
}

clockWorker.onmessage = pulse;
pulse();

addEventListener('pagehide', () => clockWorker.terminate(), { once: true });
