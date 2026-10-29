// Runs before first paint: applies the saved theme so the page doesn't flash,
// and marks the document as JS-capable (enables scroll-reveal; no-JS shows everything).
(function () {
  try {
    var t = localStorage.getItem('ia-theme') || 'auto';
    var dark = t === 'dark' || (t === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.setAttribute('data-theme', t);
    document.documentElement.classList.toggle('dark', dark);
    document.documentElement.classList.add('js');
  } catch (e) {
    document.documentElement.classList.add('js');
  }
})();
