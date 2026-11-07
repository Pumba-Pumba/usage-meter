/** A design's name, as `/meter theme <name>` takes it. */
export type DesignName = string

declare module 'claude-code' {
  interface PluginState {
    'usage-meter': {
      /** The design the picker marks as chosen. */
      chosen: DesignName
      /** The picker's animation frame. */
      frame: number
    }
  }
}
