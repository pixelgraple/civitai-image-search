(() => {
  'use strict';
  const counter = document.getElementById('countdown');
  const end = Date.now() + Math.max(0, Number(counter.dataset.remaining) || 0) * 1000;
  function tick() {
    const seconds = Math.max(0, Math.ceil((end - Date.now()) / 1000));
    counter.textContent = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
    if (!seconds) { document.querySelector('h1').textContent = 'You can try searching again'; clearInterval(timer); }
  }
  const timer = setInterval(tick, 1000);
  tick();
})();
