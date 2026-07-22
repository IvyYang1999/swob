import { CommandRegistry } from './command-registry'

export type BuiltinViewTarget = 'chat' | 'insights' | 'lineage' | 'settings'
export type BuiltinWindowTarget = 'agent' | 'spotlight'
export type BuiltinSessionAction = 'resume' | 'rename' | 'smartRename' | 'addToFolder' | 'removeFromFolder'
export type BuiltinFolderAction = 'rename' | 'move'
export type BuiltinOrganizeAction = 'project' | 'smart'

export interface BuiltinCommandContext {
  payload?: unknown
  openView?: (target: BuiltinViewTarget, payload?: unknown) => unknown | Promise<unknown>
  togglePanel?: (target: 'info', payload?: unknown) => unknown | Promise<unknown>
  toggleWindow?: (target: BuiltinWindowTarget, payload?: unknown) => unknown | Promise<unknown>
  sessionAction?: (action: BuiltinSessionAction, payload?: unknown) => unknown | Promise<unknown>
  folderAction?: (action: BuiltinFolderAction, payload?: unknown) => unknown | Promise<unknown>
  organize?: (action: BuiltinOrganizeAction, payload?: unknown) => unknown | Promise<unknown>
}

export const BUILTIN_COMMAND_IDS = {
  viewChat: 'view.chat',
  viewInsights: 'view.insights',
  viewLineage: 'view.lineage',
  viewSettings: 'view.settings',
  panelInfo: 'panel.info',
  windowAgent: 'window.agent',
  windowSpotlight: 'window.spotlight',
  sessionResume: 'session.resume',
  sessionRename: 'session.rename',
  sessionSmartRename: 'session.smart-rename',
  sessionAddToFolder: 'session.add-to-folder',
  sessionRemoveFromFolder: 'session.remove-from-folder',
  folderRename: 'folder.rename',
  folderMove: 'folder.move',
  organizeProject: 'sessions.organize-project',
  organizeSmart: 'sessions.organize-smart'
} as const

export type BuiltinCommandId = (typeof BUILTIN_COMMAND_IDS)[keyof typeof BUILTIN_COMMAND_IDS]

function requireCapability<T extends (...args: never[]) => unknown>(
  capability: T | undefined,
  commandId: BuiltinCommandId
): T {
  if (!capability) throw new Error(`Command capability unavailable: ${commandId}`)
  return capability
}

export function createBuiltinCommandRegistry(): CommandRegistry<BuiltinCommandContext> {
  const registry = new CommandRegistry<BuiltinCommandContext>()
  const source = { kind: 'builtin' as const }

  const viewCommands: Array<[BuiltinCommandId, string, BuiltinViewTarget]> = [
    [BUILTIN_COMMAND_IDS.viewChat, 'toolbar.chat', 'chat'],
    [BUILTIN_COMMAND_IDS.viewInsights, 'toolbar.insights', 'insights'],
    [BUILTIN_COMMAND_IDS.viewLineage, 'toolbar.lineage', 'lineage'],
    [BUILTIN_COMMAND_IDS.viewSettings, 'toolbar.settings', 'settings']
  ]
  for (const [id, title, target] of viewCommands) {
    registry.register({ id, title, category: 'view', source, run: (context) => requireCapability(context.openView, id)(target, context.payload) })
  }

  registry.register({
    id: BUILTIN_COMMAND_IDS.panelInfo,
    title: 'toolbar.toggle_info',
    category: 'panel',
    source,
    run: (context) => requireCapability(context.togglePanel, BUILTIN_COMMAND_IDS.panelInfo)('info', context.payload)
  })

  for (const [id, title, target] of [
    [BUILTIN_COMMAND_IDS.windowAgent, 'toolbar.agent', 'agent'],
    [BUILTIN_COMMAND_IDS.windowSpotlight, 'toolbar.spotlight', 'spotlight']
  ] as const) {
    registry.register({ id, title, category: 'window', source, run: (context) => requireCapability(context.toggleWindow, id)(target, context.payload) })
  }

  const sessionCommands: Array<[BuiltinCommandId, string, BuiltinSessionAction]> = [
    [BUILTIN_COMMAND_IDS.sessionResume, 'context.resume', 'resume'],
    [BUILTIN_COMMAND_IDS.sessionRename, 'context.rename', 'rename'],
    [BUILTIN_COMMAND_IDS.sessionSmartRename, 'context.smart_rename', 'smartRename'],
    [BUILTIN_COMMAND_IDS.sessionAddToFolder, 'context.add_to_folder', 'addToFolder'],
    [BUILTIN_COMMAND_IDS.sessionRemoveFromFolder, 'context.remove_from_folder', 'removeFromFolder']
  ]
  for (const [id, title, action] of sessionCommands) {
    registry.register({ id, title, category: 'session', source, run: (context) => requireCapability(context.sessionAction, id)(action, context.payload) })
  }

  for (const [id, title, action] of [
    [BUILTIN_COMMAND_IDS.folderRename, 'folder.rename', 'rename'],
    [BUILTIN_COMMAND_IDS.folderMove, 'folder.move', 'move']
  ] as const) {
    registry.register({ id, title, category: 'folder', source, run: (context) => requireCapability(context.folderAction, id)(action, context.payload) })
  }

  for (const [id, title, action] of [
    [BUILTIN_COMMAND_IDS.organizeProject, 'organize.project', 'project'],
    [BUILTIN_COMMAND_IDS.organizeSmart, 'organize.smart', 'smart']
  ] as const) {
    registry.register({ id, title, category: 'organize', source, run: (context) => requireCapability(context.organize, id)(action, context.payload) })
  }

  return registry
}

export const SESSION_CONTEXT_ACTION_COMMAND_IDS: Readonly<Record<BuiltinSessionAction, BuiltinCommandId>> = {
  resume: BUILTIN_COMMAND_IDS.sessionResume,
  rename: BUILTIN_COMMAND_IDS.sessionRename,
  smartRename: BUILTIN_COMMAND_IDS.sessionSmartRename,
  addToFolder: BUILTIN_COMMAND_IDS.sessionAddToFolder,
  removeFromFolder: BUILTIN_COMMAND_IDS.sessionRemoveFromFolder
}
