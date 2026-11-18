import { useCallback, useEffect, useId, useRef, useState } from 'react'
import type { ExtractResult } from '../../../../shared/expenseExtraction'
import type { ExtractOutcome, ScanErrorCode } from '../../data/extract'
import { useLang } from '../../lib/i18n'
import { prepareScanImage, type PrepareError, type PreparedImage } from '../../lib/scanImageDom'
import { UploadIcon } from '../icons'

export type ScanPhase = 'pick' | 'reading' | 'error'

export interface ScanState {
  phase: ScanPhase
  /** The image being read, or the one a failed reading can be sent again with. Memory only. */
  image: PreparedImage | null
  error: ScanErrorCode | PrepareError | null
  /** The last reading found no expense in the image. */
  none: boolean
  /** Seconds since the reading started. */
  elapsed: number
  /** Seconds before Try again works (a rate limit's Retry-After). */
  retryIn: number
}

export interface Scan extends ScanState {
  /** Prepare a picked, pasted or dropped image and read it. */
  start: (file: Blob) => void
  /** Send the same prepared image again. */
  retry: () => void
  /** Stop waiting: a late answer adds nothing. */
  cancel: () => void
}

const IDLE: ScanState = { phase: 'pick', image: null, error: null, none: false, elapsed: 0, retryIn: 0 }

/**
 * One AI reading at a time. Each start or retry takes a new request number;
 * an answer for an older one, or one that arrives after Cancel (its signal
 * aborted), is dropped, so nothing is ever added from a reading the person
 * walked away from. The image lives only in this state: it is let go once a
 * reading succeeds and with the sheet, and never stored.
 */
export function useScan(extract: (image: PreparedImage, signal: AbortSignal) => Promise<ExtractOutcome>, onResult: (result: ExtractResult) => void): Scan {
  const [state, setState] = useState<ScanState>(IDLE)
  const request = useRef(0)
  const abort = useRef<AbortController | null>(null)
  const extractRef = useRef(extract)
  extractRef.current = extract
  const resultRef = useRef(onResult)
  resultRef.current = onResult

  const read = useCallback(async (image: PreparedImage, req: number): Promise<void> => {
    abort.current?.abort()
    const controller = new AbortController()
    abort.current = controller
    setState({ phase: 'reading', image, error: null, none: false, elapsed: 0, retryIn: 0 })
    const outcome = await extractRef.current(image, controller.signal)
    if (req !== request.current || controller.signal.aborted) return
    abort.current = null
    if (outcome.ok) {
      if (outcome.result.expenses.length === 0) {
        setState({ ...IDLE, none: true })
        return
      }
      setState(IDLE)
      resultRef.current(outcome.result)
      return
    }
    if (outcome.code === 'cancelled') {
      setState(IDLE)
      return
    }
    setState({ phase: 'error', image, error: outcome.code, none: false, elapsed: 0, retryIn: outcome.retryAfter ?? 0 })
  }, [])

  const start = useCallback(
    (file: Blob): void => {
      const req = ++request.current
      abort.current?.abort()
      abort.current = null
      setState({ phase: 'reading', image: null, error: null, none: false, elapsed: 0, retryIn: 0 })
      void prepareScanImage(file).then((prepared) => {
        if (req !== request.current) return
        if (!prepared.ok) {
          setState({ ...IDLE, error: prepared.code })
          return
        }
        void read(prepared.image, req)
      })
    },
    [read]
  )

  const retry = useCallback((): void => {
    const image = state.image
    if (!image) return
    void read(image, ++request.current)
  }, [state.image, read])

  const cancel = useCallback((): void => {
    request.current++
    abort.current?.abort()
    abort.current = null
    setState(IDLE)
  }, [])

  // Closing the sheet stops the reading.
  useEffect(
    () => () => {
      request.current++
      abort.current?.abort()
    },
    []
  )

  // The seconds shown while reading: text, not a spinner (nothing moves at rest).
  const reading = state.phase === 'reading'
  useEffect(() => {
    if (!reading) return
    const began = Date.now()
    const timer = setInterval(() => setState((s) => (s.phase === 'reading' ? { ...s, elapsed: Math.floor((Date.now() - began) / 1000) } : s)), 1000)
    return () => clearInterval(timer)
  }, [reading])

  const waiting = state.retryIn > 0
  useEffect(() => {
    if (!waiting) return
    const timer = setInterval(() => setState((s) => ({ ...s, retryIn: Math.max(0, s.retryIn - 1) })), 1000)
    return () => clearInterval(timer)
  }, [waiting])

  return { ...state, start, retry, cancel }
}

interface Props {
  scan: Scan
  /** The sheet's "drop it here" state (window drag events). */
  over: boolean
  demo: boolean
  /** Why a new reading can't start now (offline, signed out, lists still loading), or null. */
  blocked: 'offline' | 'signed_out' | 'loading' | null
  onManual: () => void
}

/**
 * Choosing the image and waiting for its reading. Pasting and dropping work
 * anywhere on the sheet (ExpenseSheet listens on the window); the button
 * opens the file picker (no `capture`, so a phone offers its photos).
 */
export default function ScanPanel({ scan, over, demo, blocked, onManual }: Props) {
  const offId = useId()
  const { t } = useLang()
  const inputRef = useRef<HTMLInputElement>(null)
  const pickRef = useRef<HTMLButtonElement>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)
  const retryRef = useRef<HTMLButtonElement>(null)
  const manualRef = useRef<HTMLButtonElement>(null)
  const coarse = typeof window !== 'undefined' && Boolean(window.matchMedia?.('(pointer: coarse)').matches)
  const failed = scan.phase === 'error'
  const retryOff = scan.retryIn > 0

  // Focus follows the stage: the pick button, Cancel while reading, Try again (or Type it instead) after a failure.
  useEffect(() => {
    if (scan.phase === 'pick') pickRef.current?.focus({ preventScroll: true })
    else if (scan.phase === 'reading') cancelRef.current?.focus({ preventScroll: true })
    else (retryRef.current && !retryRef.current.disabled ? retryRef.current : manualRef.current)?.focus({ preventScroll: true })
  }, [scan.phase])

  if (scan.phase === 'reading')
    return (
      <div className="exp-scan exp-scan-reading">
        {scan.image && <img className="exp-scan-preview" src={scan.image.dataUrl} alt={t('scan.preview')} />}
        <div className="exp-reading-line">
          <p className="exp-reading" role="status">
            {t('scan.reading')}
          </p>
          <span className="exp-reading-time" aria-hidden="true">
            {t('scan.elapsed', { s: scan.elapsed })}
          </span>
        </div>
        <div className="modal-actions exp-scan-actions">
          <button ref={cancelRef} type="button" className="btn btn-ghost exp-scan-cancel" onClick={scan.cancel}>
            {t('scan.cancel')}
          </button>
        </div>
      </div>
    )

  if (failed && scan.image)
    return (
      <div className="exp-scan exp-scan-failed">
        <p className="form-error exp-scan-error" role="alert">
          {t(`scan.err.${scan.error as Exclude<ScanErrorCode, 'cancelled'>}`)}
        </p>
        <div className="modal-actions exp-scan-actions">
          <button ref={manualRef} type="button" className="btn btn-ghost exp-scan-manual" onClick={onManual}>
            {t('scan.manual')}
          </button>
          <button ref={retryRef} type="button" className="btn btn-primary exp-scan-retry" disabled={retryOff || blocked !== null} onClick={scan.retry}>
            {retryOff ? `${t('scan.retry')} · ${t('scan.elapsed', { s: scan.retryIn })}` : t('scan.retry')}
          </button>
        </div>
      </div>
    )

  return (
    <div className="exp-scan exp-scan-pick-stage">
      {scan.error && (
        <p className="form-error exp-scan-error" role="alert">
          {t(`scan.err.${scan.error as Exclude<ScanErrorCode, 'cancelled'>}`)}
        </p>
      )}
      {scan.none && (
        <p className="draft-note exp-scan-none" role="status">
          {t('scan.none')}
        </p>
      )}
      <div className={`exp-drop${over ? ' is-over' : ''}`}>
        <p className="exp-drop-text">{t(coarse ? 'scan.dropTouch' : 'scan.drop')}</p>
        <button
          ref={pickRef}
          type="button"
          className="btn btn-ghost exp-scan-pick"
          disabled={blocked !== null}
          aria-describedby={blocked ? offId : undefined}
          onClick={() => inputRef.current?.click()}
        >
          <UploadIcon /> {t('scan.pick')}
        </button>
        {blocked && (
          <p className="hint exp-scan-off" id={offId}>
            {t(`scan.err.${blocked}`)}
          </p>
        )}
        <input
          ref={inputRef}
          type="file"
          accept="image/*"
          className="visually-hidden exp-scan-input"
          tabIndex={-1}
          aria-hidden="true"
          onChange={(e) => {
            const file = e.target.files?.[0]
            // Cleared, so choosing the same file again still reads it.
            e.target.value = ''
            if (file) scan.start(file)
          }}
        />
      </div>
      <p className="hint exp-privacy">{t(demo ? 'scan.privacyDemo' : 'scan.privacy')}</p>
      <div className="modal-actions exp-scan-actions">
        <button type="button" className="btn btn-ghost exp-scan-back" onClick={onManual}>
          {t('scan.manual')}
        </button>
      </div>
    </div>
  )
}
