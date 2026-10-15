(() => {
  'use strict';
  // CSS columns run down the page before moving right. Choose visible images
  // by their actual positions, not by the first N records in the result list.
  function mount(root) {
    const images = [...root.querySelectorAll('img[data-preview]')];
    let stopped = false, observer = null, resizeTimer;
    const viewport = () => ({ width: window.innerWidth, height: window.innerHeight });
    const visible = rect => rect.bottom > 0 && rect.top < viewport().height && rect.right > 0 && rect.left < viewport().width;
    function load(img, priority = 'low') {
      if (stopped || !img.isConnected) return;
      const rect = img.getBoundingClientRect();
      const width = rect.width * Math.min(2, Math.max(1, window.devicePixelRatio || 1)) <= 320 ? 320 : 720;
      if (priority === 'high') img.fetchPriority = 'high';
      // Resizing may upgrade a loaded preview, but never downloads a smaller
      // replacement or fetches the original image.
      if (Number(img.dataset.previewLoaded || 0) >= width) return;
      const url = new URL(img.dataset.preview, location.href);
      if (url.origin !== location.origin || !url.pathname.endsWith('/media.php') || url.searchParams.get('variant') !== 'thumb') return;
      url.searchParams.set('w', String(width));
      img.fetchPriority = priority;
      img.loading = 'eager';
      img.dataset.previewLoaded = String(width);
      img.src = url.href;
    }
    function nearViewport() {
      return images.filter(img => img.isConnected).map(img => ({ img, rect: img.getBoundingClientRect() }))
        .filter(({ rect }) => rect.bottom > -300 && rect.top < viewport().height + 300 && rect.right > 0 && rect.left < viewport().width)
        .sort((a, b) => Number(visible(b.rect)) - Number(visible(a.rect)) || a.rect.top - b.rect.top || a.rect.left - b.rect.left);
    }
    function refresh() {
      if (stopped) return;
      for (const { img, rect } of nearViewport()) load(img, visible(rect) ? 'high' : 'low');
    }
    function onResize() {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(refresh, 100);
    }
    refresh();
    if ('IntersectionObserver' in window) {
      observer = new IntersectionObserver(entries => {
        const approaching = entries.filter(entry => entry.isIntersecting)
          .sort((a, b) => Number(visible(b.boundingClientRect)) - Number(visible(a.boundingClientRect)) || a.boundingClientRect.top - b.boundingClientRect.top);
        for (const entry of approaching) load(entry.target, visible(entry.boundingClientRect) ? 'high' : 'low');
      }, { rootMargin: '300px 0px' });
      images.forEach(img => observer.observe(img));
    } else {
      // Keep the same bounded viewport loading on browsers without observers.
      window.addEventListener('scroll', refresh, { passive: true });
    }
    window.addEventListener('resize', onResize);
    return () => {
      stopped = true; observer?.disconnect(); clearTimeout(resizeTimer);
      window.removeEventListener('scroll', refresh); window.removeEventListener('resize', onResize);
    };
  }
  window.CivitaiGalleryImages = { mount };
})();
