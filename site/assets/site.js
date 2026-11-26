// Shared behaviour for every page on the site: theme toggle, sticky-nav shadow,
// mobile menu, scroll-reveal and the footer year. Page-specific scripts stay inline.
(function () {
  var root = document.documentElement;

  // Theme toggle (light ⇄ dark; respects prior 'auto' by resolving current)
  var themeBtn = document.getElementById('theme');
  if (themeBtn) {
    themeBtn.addEventListener('click', function () {
      var isDark = root.classList.contains('dark');
      var next = isDark ? 'light' : 'dark';
      root.classList.toggle('dark', next === 'dark');
      root.setAttribute('data-theme', next);
      try { localStorage.setItem('ia-theme', next); } catch (e) {}
    });
  }

  // Nav shadow on scroll
  var nav = document.getElementById('nav');
  if (nav) {
    var onScroll = function () { nav.classList.toggle('scrolled', window.scrollY > 8); };
    onScroll(); window.addEventListener('scroll', onScroll, { passive: true });
  }

  // Mobile menu
  var menu = document.getElementById('menu');
  var links = document.getElementById('navlinks');
  if (menu && links) {
    menu.addEventListener('click', function () {
      var open = links.classList.toggle('open');
      menu.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
    links.addEventListener('click', function (e) {
      if (e.target.closest('a')) { links.classList.remove('open'); menu.setAttribute('aria-expanded', 'false'); }
    });
  }

  // Reveal on scroll — enhancement only. Content must never stay hidden.
  var revealEls = document.querySelectorAll('.reveal');
  if (revealEls.length) {
    var revealAll = function () { revealEls.forEach(function (el) { el.classList.add('in'); }); };
    var reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (!reduce && 'IntersectionObserver' in window) {
      var io = new IntersectionObserver(function (entries) {
        entries.forEach(function (en) { if (en.isIntersecting) { en.target.classList.add('in'); io.unobserve(en.target); } });
      }, { threshold: 0, rootMargin: '0px 0px -8% 0px' });
      revealEls.forEach(function (el) { io.observe(el); });
      // Safety net: never let a missed observer callback leave content invisible.
      setTimeout(revealAll, 2500);
    } else {
      revealAll();
    }
  }

  // Year
  var year = document.getElementById('year');
  if (year) year.textContent = new Date().getFullYear();
})();
