import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { EncryptionBadge } from './encryption-badge.js'

describe('EncryptionBadge', () => {
  it('renders nothing for an unencrypted profile', () => {
    const { container } = render(<EncryptionBadge state="off" />)

    expect(container).toBeEmptyDOMElement()
  })

  it('renders a locked indicator', () => {
    render(<EncryptionBadge state="locked" />)

    expect(screen.getByRole('img', { name: /locked/i })).toBeInTheDocument()
  })

  it('renders an unlocked indicator', () => {
    render(<EncryptionBadge state="unlocked" />)

    expect(screen.getByRole('img', { name: /encrypted/i })).toBeInTheDocument()
  })
})
