import {
  chromeUserDataDir,
  hasChromeSession,
  launchChromeSignin,
  removeChromeSession
} from '../session/chrome-login.js'

import { type IpcHandlers } from './result.js'

export const chromeSigninHandlers = {
  status: () => ({ hasSession: hasChromeSession(), path: chromeUserDataDir() }),
  // Only an http(s) URL reaches Chrome's command line; anything else would be read as a Chrome switch.
  start: (_event, url: string) =>
    /^https?:\/\//i.test(url)
      ? launchChromeSignin(url)
      : Promise.resolve({ ok: false as const, error: 'The sign-in address must start with http:// or https://.' }),
  remove: () => removeChromeSession()
} satisfies IpcHandlers['chromeSignin']
