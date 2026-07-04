// `pnpm dev` with the CDP DevTools endpoint enabled, so a CDP client (the `butin-app` MCP server, or
// scripts/drive.mjs's connect path) can drive the running app. Sets BUTIN_REMOTE_DEBUG cross-platform
// (an inline `VAR=1 pnpm …` prefix doesn't work in Windows shells) and forwards to the normal dev command.
import { spawn } from 'node:child_process'

const child = spawn('pnpm', ['--filter', '@butinapp/core', 'dev'], {
  stdio: 'inherit',
  shell: true, // resolve pnpm(.cmd) on Windows
  env: { ...process.env, BUTIN_REMOTE_DEBUG: '1' }
})

child.on('exit', (code) => process.exit(code ?? 0))
