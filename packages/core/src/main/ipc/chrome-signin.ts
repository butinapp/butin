import {
  chromeUserDataDir,
  hasChromeSession,
  launchChromeSignin,
  removeChromeSession
} from '../session/chrome-login.js'

import { type IpcHandlers } from './result.js'

export const chromeSigninHandlers = {
  status: () => ({ hasSession: hasChromeSession(), path: chromeUserDataDir() }),
  start: (_event, url: string) => launchChromeSignin(url),
  remove: () => removeChromeSession()
} satisfies IpcHandlers['chromeSignin']
