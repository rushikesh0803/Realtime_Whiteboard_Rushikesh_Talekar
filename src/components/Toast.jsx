// src/components/Toast.jsx
import React, { useEffect } from 'react'

/**
 * toasts: [{ id, name?, text, timeoutMs? }]
 * onRemove: (id) => void
 */
export default function Toast({ toasts = [], onRemove = () => {} }) {
  // Auto-dismiss per-toast (falls back to 5000ms)
  useEffect(() => {
    const timers = toasts.map(t =>
      setTimeout(() => onRemove(t.id), t.timeoutMs ?? 5000)
    )
    return () => timers.forEach(clearTimeout)
  }, [toasts, onRemove])

  return (
    <div className="fixed bottom-4 right-4 z-50 space-y-2 pointer-events-none">
      {toasts.map((t) => (
        <div
          key={t.id}
          className="relative pointer-events-auto bg-zinc-900/90 text-white px-4 py-3 rounded-lg shadow-lg max-w-xs border border-white/10 transition transform duration-200"
          style={{ animation: 'toastFadeIn 180ms ease-out' }}
          role="alert"
          aria-live="polite"
        >
          <div className="font-semibold truncate pr-6">
            {t.name || 'Notification'}
          </div>
          <div className="text-sm opacity-90 break-words">{t.text}</div>

          {/* Close button */}
          <button
            type="button"
            className="absolute top-2 right-2 text-white/70 hover:text-white focus:outline-none"
            aria-label="Dismiss"
            onClick={() => onRemove(t.id)}
          >
            ×
          </button>
        </div>
      ))}
      {/* tiny inline keyframes so you don’t need extra CSS files */}
      <style>{`
        @keyframes toastFadeIn {
          from { opacity: 0; transform: translateY(8px); }
          to   { opacity: 1; transform: translateY(0); }
        }
      `}</style>
    </div>
  )
}
