import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, type BankrollMove } from '../../../shared/types'
import { bet } from '../test-utils'
import { BACKUP_VERSION, makeBackup, planRestore, readBackup } from './backup'

const ME = '11111111-2222-4333-8444-555555555555'
const id = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const move = (n: number, amount: number): BankrollMove => ({ id: id(100 + n), date: '2026-08-01', amount, note: '', createdAt: '2026-08-01T00:00:00Z', updatedAt: '2026-08-01T00:00:00Z' })
const settings = { ...DEFAULT_SETTINGS, startingBankroll: 1000, oddsFormat: 'decimal' as const }

const bets = [bet({ id: id(1), date: '2026-08-01', amount: 20, stake: 10, odds: 3 }), bet({ id: id(2), date: '2026-08-02', amount: -10, stake: 10 }), bet({ id: id(3), date: '2026-08-03', status: 'pending', stake: 5 })]
const backup = makeBackup(bets, [move(1, 500)], settings, { id: ME, email: 'me@example.com' }, new Date('2026-10-20T09:00:00Z'))
const text = JSON.stringify(backup)

describe('readBackup', () => {
  it('reads back exactly what was written: bets, moves, settings, version', () => {
    const read = readBackup(text)
    if (!read.ok) throw new Error(read.key)
    expect(read.bad).toEqual([])
    expect(read.backup.version).toBe(BACKUP_VERSION)
    expect(read.backup.bets).toEqual(backup.bets)
    expect(read.backup.moves).toEqual(backup.moves)
    expect(read.backup.settings).toEqual(backup.settings)
  })

  it('refuses what is not a backup, a damaged one, one from a newer version, or nonsense settings, before anything is applied', () => {
    expect(readBackup('{oops')).toMatchObject({ ok: false, key: 'backup.notJson' })
    expect(readBackup('{"format":"other"}')).toMatchObject({ ok: false, key: 'backup.notBackup' })
    expect(readBackup(JSON.stringify({ ...backup, version: 2 }))).toMatchObject({ ok: false, key: 'backup.newer', vars: { version: 2 } })
    expect(readBackup(JSON.stringify({ ...backup, bets: 'x' }))).toMatchObject({ ok: false, key: 'backup.damaged' })
    expect(readBackup(JSON.stringify({ ...backup, settings: { ...backup.settings, unitSize: -1 } }))).toMatchObject({ ok: false, key: 'backup.badSettings' })
  })

  it('leaves out, and lists, an entry that fails the app’s checks', () => {
    const bad = { ...backup, bets: [...backup.bets, { ...backup.bets[0], id: 'not-a-uuid' }, { ...backup.bets[0], id: id(9), status: 'won', amount: -5 }], moves: [...backup.moves, { ...backup.moves[0], id: id(99), amount: 0 }] }
    const read = readBackup(JSON.stringify(bad))
    if (!read.ok) throw new Error(read.key)
    expect(read.backup.bets).toHaveLength(3)
    expect(read.bad).toEqual([
      expect.objectContaining({ kind: 'bet', index: 4, key: 'backup.badEntry' }),
      expect.objectContaining({ kind: 'bet', index: 5, key: 'invalid.wonPositive' }),
      expect.objectContaining({ kind: 'move', index: 2, key: 'invalid.moveZero' })
    ])
  })
})

describe('planRestore', () => {
  let n = 1000
  const newId = (): string => id(n++)

  it('of this account: adds only what is missing, keeps its ids, never changes what is here', () => {
    const edited = { ...bets[0], note: 'edited since' }
    const plan = planRestore(backup, { userId: ME, bets: [edited, bets[2]], moves: [], settings }, newId)
    expect(plan.otherAccount).toBe(false)
    expect(plan.newBets.map((b) => b.id)).toEqual([id(2)])
    expect(plan.sameBets).toBe(1)
    expect(plan.changedBets).toBe(1)
    expect(plan.newMoves.map((m) => m.id)).toEqual([id(101)])
    expect(plan.settingsDiffer).toBe(false)
  })

  it('restoring the same backup twice adds nothing the second time', () => {
    const plan = planRestore(backup, { userId: ME, bets, moves: [move(1, 500)], settings }, newId)
    expect(plan.newBets).toEqual([])
    expect(plan.newMoves).toEqual([])
    expect(plan.sameBets).toBe(3)
  })

  it('of another account: new ids, and bets that look like bets here are possible duplicates', () => {
    const plan = planRestore(backup, { userId: 'someone-else', bets: [bets[1]], moves: [], settings: DEFAULT_SETTINGS }, newId)
    expect(plan.otherAccount).toBe(true)
    expect(plan.duplicateBets).toHaveLength(1)
    expect(plan.newBets).toHaveLength(2)
    expect([...plan.newBets, ...plan.duplicateBets].every((b) => !bets.some((x) => x.id === b.id))).toBe(true)
    expect(plan.newMoves[0].id).not.toBe(id(101))
    expect(plan.settingsDiffer).toBe(true)
  })
})
