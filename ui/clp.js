// ---- CloudPanel-style chrome: light/dark switch + header shadow ----
// The theme is applied before first paint by the inline script in index.html; this only flips it.
// An explicit choice is remembered per browser; without one the page follows the OS setting.
(function(){
  var sw = document.getElementById('theme-switch');
  if (sw) sw.addEventListener('click', function(){
    var dark = document.documentElement.classList.toggle('dark');
    try { localStorage.setItem('rhc-theme', dark ? 'dark' : 'light'); } catch(e){}
  });

  // the header sits flat at rest and gets a shadow once content scrolls under it
  var bar = document.querySelector('.topbar');
  function onScroll(){ if (bar) bar.classList.toggle('scrolled', window.scrollY > 4); }
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();
})();
