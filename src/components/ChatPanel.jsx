// src/components/ChatPanel.jsx
import React, { useEffect, useMemo, useRef, useState } from 'react'
import { apiFetch } from '../lib/api.js'

const EMOJIS = ['👍','❤️','😂','🎉','🔥','👏']

const fmt = (ts) => { try { return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) } catch { return '' } }
const emailPrefix = (s) => { if (!s) return ''; const t = String(s).trim(); return t.includes('@') ? t.split('@')[0] : t }
const displayNameFromUser = (u = {}) =>
  u.displayName || (u.name && emailPrefix(u.name)) || (u.username && String(u.username).trim()) || emailPrefix(u.email) || 'User'
const displayNameFromMessage = (m = {}) =>
  emailPrefix(m.name || m.displayName || m.username || m.userName || m.email || m.userEmail || '') || 'User'

function mergeById(oldArr, newArr) {
  const map = new Map()
  ;[...oldArr, ...newArr].forEach((m) => {
    if (!m?.id) return
    const cur = map.get(m.id)
    if (!cur || (m.ts ?? 0) >= (cur.ts ?? 0)) map.set(m.id, m)
  })
  return Array.from(map.values()).sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0))
}
function useDebounced(fn, delay = 500) {
  const ref = useRef()
  return (...args) => { clearTimeout(ref.current); ref.current = setTimeout(() => fn(...args), delay) }
}
const roleBadge = (role) => role === 'owner' ? '👑 Owner' : role === 'editor' ? '✏️ Editor' : '👁️ Viewer'

export default function ChatPanel({ socket, boardId, token, me = {}, open, onClose, history = [] }) {
  const [messages, setMessages] = useState(() => Array.isArray(history) ? history : [])
  const [text, setText] = useState('')
  const [replyTo, setReplyTo] = useState(null)
  const [typing, setTyping] = useState({})
  const [roles, setRoles] = useState({})
  const [pendingOut, setPendingOut] = useState([])
  const boxRef = useRef(null)

  const myDisplayName = useMemo(() => displayNameFromUser(me), [me])
  const historyKey = useMemo(() => `wb:chat:${boardId}`, [boardId])

  useEffect(() => { if (Array.isArray(history)) setMessages((prev) => mergeById(prev, history)) }, [history])
  useEffect(() => { try { localStorage.setItem(historyKey, JSON.stringify(messages.slice(-2000))) } catch {} }, [messages, historyKey])

  async function fetchRoles() {
    try {
      const r = await apiFetch(`/api/boards/${boardId}/members`)
      if (!r.ok) return
      const arr = await r.json()
      const m = {}; for (const it of arr) m[it.userId] = it.role
      setRoles(m)
    } catch {}
  }
  async function fetchChatFromServer() {
    try {
      const url = token ? `/api/boards/${boardId}?token=${encodeURIComponent(token)}` : `/api/boards/${boardId}`
      const r = await apiFetch(url)
      if (!r.ok) return
      const b = await r.json()
      const serverChat = Array.isArray(b?.chat) ? b.chat : []
      if (serverChat.length) setMessages((prev) => mergeById(prev, serverChat))
    } catch {}
  }

  useEffect(() => { if (boardId) { fetchChatFromServer(); fetchRoles() } }, [boardId])

  useEffect(() => {
    if (!socket) return
    const onConnect = () => {
      fetchChatFromServer(); fetchRoles()
      setPendingOut((queued) => {
        if (!queued.length) return queued
        queued.forEach((msg) => socket.emit('chat:message', msg, () => {}))
        return []
      })
    }
    socket.on('connect', onConnect)
    return () => socket.off('connect', onConnect)
  }, [socket, boardId])

  useEffect(() => {
    if (!socket) return
    const onMsg = (m) => {
      if (m.boardId && m.boardId !== boardId) return
      const withName = { ...m, name: displayNameFromMessage(m) }
      setMessages((prev) => mergeById(prev, [withName]))
    }
    const onReact = (p) => {
      if (p.boardId && p.boardId !== boardId) return
      const { messageId, emoji, userId, toggle } = p
      setMessages((prev) =>
        prev.map((m) => {
          if (m.id !== messageId) return m
          const reactions = { ...(m.reactions || {}) }
          const set = new Set(reactions[emoji] || [])
          if (toggle === false) set.delete(userId); else set.add(userId)
          reactions[emoji] = Array.from(set)
          return { ...m, reactions }
        })
      )
    }
    const onTyping = (p) => {
      if (p.boardId && p.boardId !== boardId) return
      setTyping((prev) => {
        const next = { ...prev }
        const name = emailPrefix(p.name || p.userName || p.username || p.email) || 'User'
        if (p.typing) next[p.userId] = name; else delete next[p.userId]
        return next
      })
    }
    socket.on('chat:message', onMsg)
    socket.on('chat:react', onReact)
    socket.on('chat:typing', onTyping)
    return () => { socket.off('chat:message', onMsg); socket.off('chat:react', onReact); socket.off('chat:typing', onTyping) }
  }, [socket, boardId])

  useEffect(() => { if (open && boxRef.current) boxRef.current.scrollTop = boxRef.current.scrollHeight }, [messages, open])

  const typers = useMemo(() => {
    const mine = myDisplayName
    return Object.values(typing).filter((n) => n && n !== mine)
  }, [typing, myDisplayName])
  const typingText = typers.length ? `${typers.slice(0, 2).join(', ')}${typers.length > 2 ? ' and others' : ''} typing…` : ''

  const debouncedStart = useDebounced(() => { socket?.emit('chat:typing', { boardId, userId: me.id, name: myDisplayName, typing: true }) }, 120)
  const debouncedStop  = useDebounced(() => { socket?.emit('chat:typing', { boardId, userId: me.id, name: myDisplayName, typing: false }) }, 250)

  const react = (m, emoji) => { socket?.emit('chat:react', { boardId, messageId: m.id, emoji, userId: me.id, toggle: true }) }

  const send = async () => {
    const raw = text.trim()
    if (!raw) return
    const msg = {
      id: (globalThis.crypto?.randomUUID?.()) || `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      userId: me.id,
      name: myDisplayName,
      text: raw,
      replyTo: replyTo?.id || null,
      ts: Date.now(),
      boardId,
    }
    try {
      const urlMatch = raw.match(/\bhttps?:\/\/\S+/i)?.[0]
      if (urlMatch) {
        const r = await apiFetch(`/api/link-preview?url=${encodeURIComponent(urlMatch)}`)
        if (r.ok) msg.linkPreview = await r.json()
      }
    } catch {}
    setMessages((prev) => mergeById(prev, [msg]))
    if (socket?.connected) socket.emit('chat:message', msg, () => {})
    else setPendingOut((q) => [...q, msg])
    setText(''); setReplyTo(null); debouncedStop()
  }

  const onKeyDown = (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() } }
  if (!open) return null

  return (
    <div id="chat-panel" className="fixed right-4 bottom-20 z-50 w-96 max-w-[95vw] bg-white dark:bg-zinc-900 border rounded-xl shadow-lg flex flex-col">
      <div className="px-3 py-2 border-b flex items-center justify-between">
        <div className="font-semibold">Chat</div>
        <button onClick={onClose} className="text-sm opacity-70 hover:opacity-100">✕</button>
      </div>

      <div ref={boxRef} className="p-3 space-y-3 overflow-auto max-h-80">
        {messages.map((m) => {
          const mine = m.userId === me.id
          const shownName = displayNameFromMessage(m)
          const role = roles[m.userId] || 'viewer'
          return (
            <div key={m.id} className={`text-sm ${mine ? 'text-right' : 'text-left'}`}>
              {m.replyTo ? (
                <div className="text-xs opacity-60 border-l pl-2 mb-1">
                  Replying to: {messages.find((x) => x.id === m.replyTo)?.text?.slice(0, 80) || 'message'}
                </div>
              ) : null}

              <div className={`inline-block px-3 py-2 rounded-lg ${mine ? 'bg-indigo-600 text-white' : 'bg-black/5 dark:bg-white/10'}`}>
                <div className="flex items-center gap-2">
                  <div className="text-[11px] opacity-80">{shownName}</div>
                  <div className="text-[10px] opacity-60">{fmt(m.ts)}</div>
                  <div className="text-[10px] opacity-70 ml-1">{roleBadge(role)}</div>
                </div>

                <div className="whitespace-pre-wrap">{m.text}</div>
                {m.linkPreview ? (
                  <a href={m.linkPreview.url} target="_blank" rel="noreferrer" className="mt-2 block border rounded-lg p-2 hover:bg-black/5 dark:hover:bg-white/5">
                    {m.linkPreview.image ? <img src={m.linkPreview.image} alt="" className="max-h-32 w-auto rounded mb-2" /> : null}
                    <div className="text-sm font-medium">{m.linkPreview.title || m.linkPreview.siteName || m.linkPreview.url}</div>
                    <div className="text-xs opacity-70">{m.linkPreview.description}</div>
                  </a>
                ) : null}

                <div className="mt-1 flex gap-1">
                  {EMOJIS.map((e) => (
                    <button key={e} className="text-xs opacity-80 hover:opacity-100" onClick={() => react(m, e)}>
                      {e}{m.reactions?.[e]?.length ? ` ${m.reactions[e].length}` : ''}
                    </button>
                  ))}
                  <button className="text-xs opacity-60 hover:opacity-100" onClick={() => setReplyTo(m)}>↩ Reply</button>
                </div>
              </div>
            </div>
          )
        })}
      </div>

      <div className="p-2 border-t">
        {replyTo ? (
          <div className="text-xs mb-1 opacity-70">
            Replying to: <span className="italic">{replyTo.text.slice(0, 60)}</span>
            <button className="ml-2 opacity-60 hover:opacity-100" onClick={() => setReplyTo(null)}>✕</button>
          </div>
        ) : null}

        <div className="flex gap-2">
          <textarea
            value={text}
            onChange={(e) => { setText(e.target.value); debouncedStart() }}
            onKeyDown={onKeyDown}
            onFocus={debouncedStart}
            onBlur={debouncedStop}
            rows={2}
            className="input flex-1 resize-none"
            placeholder="Type a message… (Enter to send, Shift+Enter for newline). Paste a link for preview."
          />
          <button className="btn" onClick={send}>Send</button>
        </div>

        <div className="text-[11px] mt-1 opacity-60 h-4">{typingText}</div>
      </div>
    </div>
  )
}
