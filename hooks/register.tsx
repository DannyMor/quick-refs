import type { Register } from 'claude-code'

const PANE = 'context'

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'context', description: 'Open the context pane' })
    if (e.surface === 'desktop') {
      void $.ui.open({ id: PANE, title: 'Context' })
    }
    return next(e)
  })

  on('command.run', { command: 'context' }, async $ => {
    await $.ui.open({ id: PANE, title: 'Context' })
    return { text: 'Context pane opened.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text dimColor>no references yet</Text>
      </Box>
    )
  })
}
