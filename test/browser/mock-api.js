// Mock of the iframe PluginAPI, injected just before </body> (after the plugin's
// inline script) like older Super Productivity hosts do.
(function () {
  const store = (window.__store = window.__store || {});
  window.__hooks = {};
  window.__dialogs = [];
  window.__snacks = [];
  window.__opened = [];
  window.__dialogAnswer = null;
  window.__ctx = { id: 'p-alpha', type: 'PROJECT', title: 'Alpha', taskIds: [] };
  const origOpen = window.open;
  window.open = (url) => {
    window.__opened.push(url);
    return null;
  };
  window.PluginAPI = {
    cfg: { theme: 'light', appVersion: '18.0.0', platform: 'desktop' },
    Hooks: {
      PERSISTED_DATA_CHANGED: 'persistedDataChanged',
      WORK_CONTEXT_CHANGE: 'workContextChange',
    },
    registerHook: async (hook, fn) => {
      (window.__hooks[hook] = window.__hooks[hook] || []).push(fn);
    },
    getAllProjects: async () => [
      { id: 'p-alpha', title: 'Alpha' },
      { id: 'p-beta', title: 'Beta' },
      { id: 'p-old', title: 'Old', isArchived: true },
    ],
    getActiveWorkContext: async () => window.__ctx,
    persistDataSynced: async (data, key) => {
      store[key || '__default'] = data;
    },
    loadSyncedData: async (key) => ((key || '__default') in store ? store[key || '__default'] : null),
    registerShortcut: (cfg) => {
      (window.__shortcuts = window.__shortcuts || {})[cfg.id] = cfg;
    },
    showSnack: (cfg) => {
      window.__snacks.push(cfg);
    },
    openDialog: async (cfg) => {
      window.__dialogs.push(cfg);
      return window.__dialogAnswer;
    },
    showIndexHtmlAsView: async () => {
      window.__snacks.push({ msg: 'showIndexHtmlAsView' });
    },
    executeNodeScript: async (req) => window.__runNode(JSON.stringify(req)).then((s) => JSON.parse(s)),
  };
  window.__fireHook = (hook, payload) => (window.__hooks[hook] || []).forEach((fn) => fn(payload));
  void origOpen;
})();
