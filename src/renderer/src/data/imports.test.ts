import { beforeEach, describe, expect, it } from 'vitest'
import { forgetImports, loadImports, markUndone, MAX_IMPORTS, recordImport } from './imports'
import { clearUserData } from './offline'

const U = 'user-1'
const batch = (id: string) => ({ id, at: '2026-10-20T10:00:00Z', file: `${id}.csv`, fingerprint: `fp-${id}`, ids: [`${id}-1`, `${id}-2`] })

beforeEach(() => {
  localStorage.clear()
  forgetImports(U)
})

describe('imports made on this device', () => {
  it('are recorded newest first, marked undone and back, and capped', () => {
    recordImport(U, batch('a'))
    recordImport(U, batch('b'))
    expect(loadImports(U).map((b) => b.id)).toEqual(['b', 'a'])
    markUndone(U, 'a')
    expect(loadImports(U).find((b) => b.id === 'a')?.undone).toBe(true)
    markUndone(U, 'a', false)
    expect(loadImports(U).find((b) => b.id === 'a')?.undone).toBe(false)
    for (let i = 0; i < MAX_IMPORTS + 5; i++) recordImport(U, batch(`x${i}`))
    expect(loadImports(U)).toHaveLength(MAX_IMPORTS)
  })

  it('are per user, gone with a sign-out, and nonsense in storage is ignored', () => {
    recordImport(U, batch('a'))
    expect(loadImports('someone-else')).toEqual([])
    localStorage.setItem('bettracker:imports:other', '[{"id":1}]')
    expect(loadImports('other')).toEqual([])
    clearUserData(U)
    forgetImports(U)
    expect(loadImports(U)).toEqual([])
  })
})
