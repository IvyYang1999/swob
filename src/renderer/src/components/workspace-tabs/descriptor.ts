/** t211I integration slot: render WorkspaceTabs directly below Toolbar, before the three-pane shell. */
export const WORKSPACE_TABS_INTEGRATION_SLOT = {
  owner: 't211I',
  mount: 'App.toolbar.after',
  state: 'DeviceCatalog.listTabs + persisted active tab id',
  guarantees: ['tab-does-not-own-files', 'scope-only-query', 'horizontal-overflow-safe']
} as const
