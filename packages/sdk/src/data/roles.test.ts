import { expectTypeOf, it } from 'vitest'

import type { RolesFor } from './roles.js'

it('constrains roles by value type', () => {
  expectTypeOf<RolesFor<number>>().toEqualTypeOf<'money' | 'count' | 'percent'>()
  expectTypeOf<RolesFor<number | null>>().toEqualTypeOf<'money' | 'count' | 'percent'>()
  expectTypeOf<RolesFor<string | null>>().toEqualTypeOf<
    'timestamp' | 'status' | 'category' | 'label' | 'identifier' | 'url' | 'text'
  >()
  expectTypeOf<RolesFor<string>>().toEqualTypeOf<
    'timestamp' | 'status' | 'category' | 'label' | 'identifier' | 'url' | 'text'
  >()
  expectTypeOf<RolesFor<boolean>>().toEqualTypeOf<never>()
})
