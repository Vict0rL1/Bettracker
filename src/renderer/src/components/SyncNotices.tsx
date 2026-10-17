import { useLang } from '../lib/i18n'

interface Props {
  /** The session ended (signed out on another device): how many changes wait for a sign-in, or null. */
  signedOut: number | null
  /** Changes storage refused, only in this window until they sync. */
  unsaved: number
  /** Changes the server refused for good, and the first reason it gave. */
  refused: { count: number; reason: string } | null
  onSignIn: () => void
  onSaveAgain: () => void
  onRetryRefused: () => void
  onDiscardRefused: () => void
}

/**
 * What stands between the user's changes and the server and needs them to
 * act: a sign-in, room on the device, or a change the server refused. Each
 * stays until it is sorted out (no dismissing what would lose data).
 */
export default function SyncNotices({ signedOut, unsaved, refused, onSignIn, onSaveAgain, onRetryRefused, onDiscardRefused }: Props) {
  const { t, tn } = useLang()
  return (
    <>
      {signedOut !== null && (
        <div className="sync-notice signed-out-notice" role="alert">
          <span className="sync-notice-text">{signedOut > 0 ? t('notice.signedOut', { changes: tn('change', signedOut) }) : t('notice.signedOutNone')}</span>
          <div className="sync-notice-actions">
            <button type="button" className="btn btn-primary notice-sign-in" onClick={onSignIn}>
              {t('notice.signIn')}
            </button>
          </div>
        </div>
      )}
      {unsaved > 0 && (
        <div className="sync-notice unsaved-notice" role="alert">
          <span className="sync-notice-text">{t('notice.unsaved', { changes: tn('change', unsaved) })}</span>
          <div className="sync-notice-actions">
            <button type="button" className="btn btn-ghost notice-save-again" onClick={onSaveAgain}>
              {t('notice.saveAgain')}
            </button>
          </div>
        </div>
      )}
      {refused && refused.count > 0 && (
        <div className="sync-notice refused-notice" role="alert">
          <span className="sync-notice-text">{t('notice.refused', { changes: tn('change', refused.count), reason: refused.reason })}</span>
          <div className="sync-notice-actions">
            <button type="button" className="btn btn-ghost notice-retry" onClick={onRetryRefused}>
              {t('notice.refusedRetry')}
            </button>
            <button type="button" className="btn btn-ghost notice-discard" onClick={onDiscardRefused}>
              {t('notice.refusedDiscard')}
            </button>
          </div>
        </div>
      )}
    </>
  )
}
