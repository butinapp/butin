import { describe, expect, it } from 'vitest'

import {
  domainLabel,
  formatRunId,
  requestFileName,
  runIdPrefix,
  runIdSlug,
  screenshotFileName,
  wsFileName
} from './naming.js'

describe('requestFileName', () => {
  it('builds a padded, slugified, method-tagged name', () => {
    expect(requestFileName(1, 'GET', 'https://api.example.com/v2/users?q=1')).toBe(
      '0001_GET_api.example.com_v2-users-q-1.json'
    )
  })

  it('falls back gracefully on an unparseable url', () => {
    expect(requestFileName(12, 'POST', 'not a url')).toBe('0012_POST_unknown_root.json')
  })

  it('appends an extra slug (e.g. GraphQL operation) when given', () => {
    expect(requestFileName(5, 'POST', 'https://api.example.com/graphql', 'AddMember')).toBe(
      '0005_POST_api.example.com_graphql_addmember.json'
    )
  })
})

describe('wsFileName', () => {
  it('names a websocket file by host + path', () => {
    expect(wsFileName(3, 'wss://rt.example.com/socket?token=x')).toBe('0003_rt.example.com_socket-token-x.json')
  })
})

describe('screenshotFileName', () => {
  it('uses host + pathname', () => {
    expect(screenshotFileName(2, 'https://example.com/dashboard')).toBe('0002_example-com-dashboard.png')
  })
})

describe('runId formatting', () => {
  it('slugifies labels', () => {
    expect(runIdSlug('Slack — Add Member!')).toBe('slack-add-member')
    expect(runIdSlug('')).toBe('recording')
  })

  it('formats a runId as YYYY-MM-DD_HHhMM_<slug>', () => {
    const d = new Date(2026, 4, 26, 14, 7) // 2026-05-26 14:07 local

    expect(formatRunId(d, 'test run')).toBe('2026-05-26_14h07_test-run')
  })

  it('extracts the timestamp prefix from a runId', () => {
    expect(runIdPrefix('2026-05-26_14h07_slack-add-member')).toBe('2026-05-26_14h07')
    expect(runIdPrefix('weird')).toBe('weird')
  })
})

describe('domainLabel', () => {
  it('uses the host without a leading www.', () => {
    expect(domainLabel('https://www.app.example.com/x?y=1')).toBe('app.example.com')
    expect(domainLabel('https://example.com')).toBe('example.com')
  })

  it('falls back for an unparseable url', () => {
    expect(domainLabel('garbage')).toBe('recording')
  })
})
