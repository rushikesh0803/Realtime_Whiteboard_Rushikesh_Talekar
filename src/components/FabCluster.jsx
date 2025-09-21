import React, { useEffect, useMemo, useState } from 'react'

/**
 * Props:
 * - onOpenChat: () => void
 * - onShare: () => void
 * - onToggleCall: () => void
 * - inCall: boolean
 * - offset?: number (tailwind spacing units, default 5)
 * - unreadCount?: number (badge)
 * - overlayOpen?: boolean  // true when ChatPanel / VoiceCall / ShareDialog is open
 */
export default function FabCluster({
  onOpenChat,
  onShare,
  onToggleCall,
  inCall,
  offset = 5,
  unreadCount = 0,
  overlayOpen = false,
}) {
  const [highlight, setHighlight] = useState(false)

  // Animate the chat button briefly when unread count increases
  useEffect(() => {
    if (unreadCount > 0) {
      setHighlight(true)
      const t = setTimeout(() => setHighlight(false), 220)
      return () => clearTimeout(t)
    }
  }, [unreadCount])

  // Base bottom from tailwind spacing units (1 unit = 4px)
  const baseBottomPx = offset * 4
  // Extra lift when an overlay is open so buttons don’t overlap panels
  const overlayLiftPx = overlayOpen ? 72 : 25

  // iOS safe-area (if available)
  const safeBottomPx = useMemo(() => {
    // Read CSS env var if supported; otherwise 0
    const div = document.createElement('div')
    div.style.paddingBottom = 'env(safe-area-inset-bottom, 0px)'
    // If the browser supports env(), computed value will be a length
    document.body.appendChild(div)
    const computed = getComputedStyle(div).paddingBottom
    document.body.removeChild(div)
    const n = parseInt(computed || '0', 10)
    return Number.isFinite(n) ? n : 0
  }, [])

  const bottomPx = baseBottomPx + overlayLiftPx + safeBottomPx

  return (
    <div
      className="fixed right-4 flex flex-col gap-3 z-40 pointer-events-none select-none"
      style={{ bottom: bottomPx }}
      role="region"
      aria-label="Whiteboard quick actions"
    >
      {/* Chat */}
      <button
        onClick={onOpenChat}
        type="button"
        className={`relative rounded-full w-12 h-12 grid place-items-center bg-indigo-600 text-white shadow-lg transition-transform focus:outline-none focus:ring-4 focus:ring-indigo-300 pointer-events-auto ${
          highlight ? 'scale-110' : 'hover:scale-105'
        }`}
        title="Open chat"
        aria-label="Open chat"
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          className="w-6 h-6"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
          aria-hidden="true"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M8 10h8m-8 4h5m-9 6v-2a4 4 0 014-4h8a4 4 0 014 4v2
               M21 12V6a2 2 0 00-2-2H5a2 2 0 00-2 2v6"
          />
        </svg>

        {unreadCount > 0 && (
          <span
            className="absolute -top-1 -right-1 bg-red-600 text-white text-[11px] leading-none px-1.5 py-1 rounded-full min-w-[20px] text-center"
            aria-label={`${unreadCount} unread messages`}
          >
            {unreadCount > 99 ? '99+' : unreadCount}
          </span>
        )}
      </button>

      {/* Share */}
      <button
        onClick={onShare}
        type="button"
        className="rounded-full w-12 h-12 grid place-items-center bg-zinc-800 text-white shadow-lg hover:scale-105 transition-transform focus:outline-none focus:ring-4 focus:ring-zinc-400 pointer-events-auto"
        title="Share"
        aria-label="Share"
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          className="w-6 h-6"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
          aria-hidden="true"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M4 12v7a1 1 0 001 1h14a1 1 0 001-1v-7
               M16 6l-4-4m0 0L8 6m4-4v16"
          />
        </svg>
      </button>

      {/* Call */}
      <button
        onClick={onToggleCall}
        type="button"
        className={`rounded-full w-12 h-12 grid place-items-center shadow-lg hover:scale-105 transition-transform focus:outline-none focus:ring-4 pointer-events-auto ${
          inCall
            ? 'bg-rose-600 text-white focus:ring-rose-300'
            : 'bg-green-600 text-white focus:ring-green-300'
        }`}
        title={inCall ? 'Leave call' : 'Start call'}
        aria-label={inCall ? 'Leave call' : 'Start call'}
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          className="w-6 h-6"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
          aria-hidden="true"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M3 5l2-2a2 2 0 012.83 0l2.12 2.12a2 2 0 010 2.83L9 10l5 5 2.05-2.05a2 2 0 012.83 0l2.12 2.12a2 2 0 010 2.83L19 21
               c-7 0-14-7-14-14z"
          />
        </svg>
      </button>
    </div>
  )
}
