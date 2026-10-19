// A worker supplies collection and scroll pulses even for inactive Civitai tabs.
// The service worker acknowledges each pulse before its network jobs finish.
const clockWorker = new Worker('offscreen-clock.js');
const clockLog = globalThis.ISSDiagnostics?.start('clock'); clockLog?.install();
let pulseInFlight = false;

async function pulse() {
  if (pulseInFlight) return;
  pulseInFlight = true;

  let deadline;
  try {
    await Promise.race([
      chrome.runtime.sendMessage({ type: 'driverPulse', source: 'offscreen' }),
      new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error('Collector heartbeat timed out.')), 5000); })
    ]);
  } catch (error) {
    clockLog?.record('warning', 'heartbeat-failed', error);
    // The service worker may be restarting. The next pulse reconnects.
  } finally {
    clearTimeout(deadline);
    pulseInFlight = false;
  }
}

clockWorker.onmessage = pulse;
pulse();

addEventListener('pagehide', () => clockWorker.terminate(), { once: true });
