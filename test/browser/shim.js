// Test-only: give the plugin iframe a desktop-like executeNodeScript backed by
// a local Node runner, so the web test app can exercise the real host APIs.
(() => {
  let real;
  try {
    Object.defineProperty(window, 'PluginAPI', {
      configurable: true,
      get() {
        return real;
      },
      set(v) {
        if (v && typeof v === 'object' && !v.__shimmed && typeof window.__runNode === 'function') {
          v.__shimmed = true;
          v.cfg = Object.assign({}, v.cfg, { platform: 'desktop' });
          v.executeNodeScript = (req) => window.__runNode(JSON.stringify(req)).then((s) => JSON.parse(s));
          const origOpen = window.open;
          window.__opened = [];
          window.open = (u, ...rest) => {
            window.__opened.push(u);
            return null;
          };
          void origOpen;
        }
        real = v;
      },
    });
  } catch (e) {
    /* ignore */
  }
})();
