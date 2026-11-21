// Applies the persisted theme before React mounts to avoid a flash of the wrong theme.
(function () {
  try {
    var pref = localStorage.getItem('ims-theme') || 'system';
    var dark = pref === 'dark' || (pref === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.classList.toggle('dark', dark);
  } catch (e) {
    /* storage unavailable: keep default */
  }
})();
