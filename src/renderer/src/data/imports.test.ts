import { beforeEach, describe, expect, it } from 'vitest'
import { foldBatchEvent, forgetImports, loadImports, markUndone, MAX_IMPORTS, recordBatchEvent, recordImport, type ImportBatch } from './imports'
import { clearUserData } from './offline'

const U = 'user-1'
const batch = (id: string): ImportBatch => ({ id, at: '2026-10-20T10:00:00Z', file: `${id}.csv`, fingerprint: `fp-${id}`, ids: [`${id}-1`, `${id}-2`] })

beforeEach(() => {
  localStorage.clear()
  forgetImports(U)
})

describe('imports made on this device', () => {
  it('are recorded newest first, marked undone and back, and capped', async () => {
    await recordImport(U, batch('a'))
    await recordImport(U, batch('b'))
    expect(loadImports(U).map((b) => b.id)).toEqual(['b', 'a'])
    await markUndone(U, 'a')
    expect(loadImports(U).find((b) => b.id === 'a')?.undone).toBe(true)
    await markUndone(U, 'a', false)
    expect(loadImports(U).find((b) => b.id === 'a')?.undone).toBe(false)
    for (let i = 0; i < MAX_IMPORTS + 5; i++) await recordImport(U, batch(`x${i}`))
    expect(loadImports(U)).toHaveLength(MAX_IMPORTS)
  })

  it('are per user, gone with a sign-out, and nonsense in storage is ignored', async () => {
    await recordImport(U, batch('a'))
    expect(loadImports('someone-else')).toEqual([])
    localStorage.setItem('bettracker:imports:other', '[{"id":1}]')
    expect(loadImports('other')).toEqual([])
    clearUserData(U)
    forgetImports(U)
    expect(loadImports(U)).toEqual([])
  })

  it('are kept in this window when storage refuses them, and stored once it takes them', async () => {
    const setItem = localStorage.setItem.bind(localStorage)
    localStorage.setItem = (key: string, value: string) => {
      if (key.startsWith('bettracker:imports:')) throw Object.assign(new Error('The quota has been exceeded.'), { name: 'QuotaExceededError' })
      setItem(key, value)
    }
    try {
      await recordImport(U, batch('a'))
      expect(loadImports(U).map((b) => b.id)).toEqual(['a'])
      expect(localStorage.getItem('bettracker:imports:user-1')).toBeNull()
    } finally {
      localStorage.setItem = setItem
    }
    await recordImport(U, batch('b'))
    expect(JSON.parse(localStorage.getItem('bettracker:imports:user-1') ?? '[]').map((b: ImportBatch) => b.id)).toEqual(['b', 'a'])
  })
})

describe('what the server made of a batch', () => {
  it('records the rows it made, once each, and only for that batch', async () => {
    await recordImport(U, batch('a'))
    await recordImport(U, batch('b'))
    await recordBatchEvent(U, { kind: 'outcome', batch: 'a', table: 'bets', made: ['a-1'] })
    await recordBatchEvent(U, { kind: 'outcome', batch: 'a', table: 'bets', made: ['a-1', 'a-2'] })
    await recordBatchEvent(U, { kind: 'outcome', batch: 'a', table: 'moves', made: ['m-1'] })
    const [b, a] = loadImports(U)
    expect(a.made).toEqual(['a-1', 'a-2'])
    expect(a.madeMoves).toEqual(['m-1'])
    expect(b.made).toBeUndefined()
  })

  it('records what an Undo removed and what the server kept, an answer told twice counting once', () => {
    const undone: ImportBatch = {
      ...batch('a'),
      undone: true,
      undo: { at: 'x', stamp: 'S', bets: ['a-1', 'a-2'], moves: [], changedHere: 0, goneHere: 0, removed: [], kept: [] }
    }
    let list = foldBatchEvent([undone], { kind: 'undo', batch: 'a', table: 'bets', id: 'a-1', removed: true })
    list = foldBatchEvent(list, { kind: 'undo', batch: 'a', table: 'bets', id: 'a-1', removed: true })
    list = foldBatchEvent(list, { kind: 'undo', batch: 'a', table: 'bets', id: 'a-2', removed: false })
    expect(list[0].undo).toMatchObject({ removed: ['a-1'], kept: ['a-2'] })
  })

  it('drops an event for a batch no longer listed', () => {
    expect(foldBatchEvent([batch('a')], { kind: 'outcome', batch: 'zz', table: 'bets', made: ['q'] })).toEqual([batch('a')])
  })
})
