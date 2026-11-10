export type ContextState = unknown

declare module 'claude-code' {
  interface PluginState {
    'context-pane': { state: Shaped<ContextState>; isClosedByPerson: Shaped<boolean> }
  }
}
