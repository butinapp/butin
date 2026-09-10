// tsc emits only JS/d.ts; theme.css is shipped verbatim (the shared brand tokens + @theme a host imports).
import { copyFileSync } from 'node:fs'

copyFileSync('src/theme.css', 'dist/theme.css')
