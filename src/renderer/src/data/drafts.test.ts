import { beforeEach, describe, expect, it } from 'vitest'
import { dayDraftId, forgetDrafts, loadDayDraft, loadDayDrafts, loadQuickDraft, MAX_DAY_DRAFTS, saveDayDraft, saveQuickDraft, type DayDraft } from './drafts'
import { clearUserData } from './offline'

const U = 'user-1'
const day = (date: string, editingId: string | null = null, savedAt = '2026-10-20T10:00:00Z'): DayDraft => ({
  savedAt,
  date,
  editingId,
  status: 'won',
  amount: '12',
  stake: '10',
  odds: '2.2',
  closing: '',
  note: 'typed',
  sport: '',
  book: '',
  betType: ''
})

beforeEach(() => {
  localStorage.clear()
  forgetDrafts(U)
})

describe('drafts', () => {
  it('the quick add keeps one, until let go', () => {
    saveQuickDraft(U, { stake: '5', odds: '', sport: 'NBA', book: '', betType: '', profit: '' })
    expect(loadQuickDraft(U)?.stake).toBe('5')
    saveQuickDraft(U, null)
    expect(loadQuickDraft(U)).toBeNull()
  })

  it('the day form keeps one per day for a new bet and one per bet edited: starting another never overwrites the first', () => {
    saveDayDraft(U, dayDraftId('2026-10-01', null), day('2026-10-01'))
    saveDayDraft(U, dayDraftId('2026-10-02', null), day('2026-10-02'))
    saveDayDraft(U, dayDraftId('2026-10-01', 'bet-a'), day('2026-10-01', 'bet-a'))
    expect(loadDayDraft(U, '2026-10-01', null)?.date).toBe('2026-10-01')
    expect(loadDayDraft(U, '2026-10-02', null)?.date).toBe('2026-10-02')
    expect(loadDayDraft(U, '2026-10-01', 'bet-a')?.editingId).toBe('bet-a')
    saveDayDraft(U, dayDraftId('2026-10-01', null), null)
    expect(loadDayDraft(U, '2026-10-01', null)).toBeNull()
    expect(loadDayDrafts(U)).toHaveLength(2)
  })

  it('keeps the newest past the cap', () => {
    for (let i = 0; i < MAX_DAY_DRAFTS + 3; i++) {
      const date = `2026-09-${String(i + 1).padStart(2, '0')}`
      saveDayDraft(U, dayDraftId(date, null), day(date, null, `2026-10-20T10:${String(i).padStart(2, '0')}:00Z`))
    }
    const kept = loadDayDrafts(U)
    expect(kept).toHaveLength(MAX_DAY_DRAFTS)
    expect(kept[0].date).toBe(`2026-09-${MAX_DAY_DRAFTS + 3}`)
    expect(kept.some((d) => d.date === '2026-09-01')).toBe(false)
  })

  it('ignores what storage holds that is no draft', () => {
    localStorage.setItem('bettracker:draft-quick:user-1', '{"stake":5}')
    expect(loadQuickDraft(U)).toBeNull()
    localStorage.setItem('bettracker:draft-day:user-1', '{"x":{"date":"2026-10-01","status":"cashout"}}')
    expect(loadDayDrafts(U)).toEqual([])
  })

  it('kept in this window when storage refuses, and forgotten on sign-out', () => {
    const store = localStorage as unknown as { setItem: (k: string, v: string) => void }
    const original = store.setItem
    store.setItem = () => {
      throw new DOMException('full', 'QuotaExceededError')
    }
    try {
      saveQuickDraft(U, { stake: '7', odds: '', sport: '', book: '', betType: '', profit: '' })
    } finally {
      store.setItem = original
    }
    expect(loadQuickDraft(U)?.stake).toBe('7')
    clearUserData(U)
    forgetDrafts(U)
    expect(loadQuickDraft(U)).toBeNull()
  })

  it('a sign-out clears the stored drafts', () => {
    saveDayDraft(U, dayDraftId('2026-10-01', null), day('2026-10-01'))
    clearUserData(U)
    forgetDrafts(U)
    expect(loadDayDrafts(U)).toEqual([])
  })
})
