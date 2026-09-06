// ---- boot: must stay last ----
setTab(tabFromPath() || state.tab, { replace: true });
window.addEventListener('popstate', () => setTab(tabFromPath() || state.tab, { noHistory: true }));
refresh(); setInterval(refresh, 10000);
