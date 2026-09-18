// ---- Material Design 2 interaction layer: touch ripples + app-bar elevation ----
// Everything here is delegated from document, so it also covers the markup the tab
// renderers rebuild on every refresh. Ripple spans are empty elements appended to the
// pressed surface, which keeps textContent (armConfirm relies on it) untouched.
(function(){
  var RIPPLE_SEL = '.btn, .chip, .tab, .site-tab, .upd-test-btn, .ssh-tab, .mod-cmd, .ssh-host,' +
                   '.ssh-tabbar .tools button, .ssh-host .acts button, .ssh-deadbar button,' +
                   '.ssh-term .pane-hd button';

  document.addEventListener('pointerdown', function(e){
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    var el = e.target.closest && e.target.closest(RIPPLE_SEL);
    if (!el || el.disabled || el.classList.contains('md-no-ripple')) return;
    var r = el.getBoundingClientRect();
    if (!r.width || !r.height) return;
    // radius reaching the farthest corner from the press point
    var dx = Math.max(e.clientX - r.left, r.right - e.clientX);
    var dy = Math.max(e.clientY - r.top, r.bottom - e.clientY);
    var d = Math.hypot(dx, dy) * 2;
    var ink = document.createElement('span');
    ink.className = 'md-ripple';
    ink.style.width = ink.style.height = d + 'px';
    ink.style.left = (e.clientX - r.left - d / 2) + 'px';
    ink.style.top  = (e.clientY - r.top  - d / 2) + 'px';
    el.appendChild(ink);
    var gone = false;
    var fade = function(){
      if (gone) return; gone = true;
      ink.classList.add('out');
      setTimeout(function(){ if (ink.parentNode) ink.remove(); }, 260);
    };
    // the press may end anywhere (or the node may be re-rendered under us)
    setTimeout(fade, 450);
    window.addEventListener('pointerup', fade, { once: true });
    window.addEventListener('pointercancel', fade, { once: true });
  }, true);

  // MD2 top app bar: flat while the page is at rest, elevated once content scrolls under it
  var bar = null;
  function onScroll(){
    bar = bar || document.querySelector('.hdr-row');
    if (bar) bar.classList.toggle('scrolled', window.scrollY > 4);
  }
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();
})();
