// src/whiteboard.jsx
import React, { useEffect, useMemo, useRef, useState } from 'react'
import { io } from 'socket.io-client'
import { Tldraw } from '@tldraw/tldraw'
import '@tldraw/tldraw/tldraw.css'

import FabCluster from './components/FabCluster.jsx'
import ChatPanel from './components/ChatPanel.jsx'
import VoiceCall from './components/VoiceCall.jsx'
import ShareDialog from './components/ShareDialog.jsx'
import BoardsList from './components/BoardsList.jsx'
import { exportBlob, tryWebShare } from './lib/share.js'
import { apiFetch } from './lib/api.js'
import usePresence from './hooks/usePresence.js'

const SERVER_URL = import.meta.env.VITE_SERVER_URL || 'http://localhost:4000'

// ---------- Avatars ----------
function avatarUrlFor(user) {
  const seed = encodeURIComponent(String(user?.id || user?.name || 'anon'))
  return 'https://api.dicebear.com/7.x/adventurer/svg?seed=' + seed + '&radius=50&backgroundType=gradientLinear'
}

// ---------- Error Boundary ----------
class ErrorBoundary extends React.Component {
  constructor(p) { super(p); this.state = { error: null, info: null } }
  static getDerivedStateFromError(error) { return { error } }
  componentDidCatch(error, info) { console.error('[UI ERROR]', error, info); this.setState({ info }) }
  render() {
    if (this.state.error) {
      const reset = () => {
        try {
          const id = localStorage.getItem('last_board_id')
          Object.keys(localStorage).forEach(k => {
            if (k.startsWith('wb:chat:') || k === 'last_board_id') localStorage.removeItem(k)
          })
          if (id) console.warn('[reset] cleared local board/chat cache for', id)
        } catch {}
        location.reload()
      }
      return (
        <div style={{ padding: 16, fontFamily: 'system-ui' }}>
          <h2>Something went wrong.</h2>
          <pre style={{ whiteSpace: 'pre-wrap', background: '#1111', padding: 12, borderRadius: 8 }}>
            {String(this.state.error?.message || this.state.error)}
          </pre>
          {this.state.info?.componentStack && (
            <pre style={{ whiteSpace: 'pre-wrap', opacity: 0.7 }}>{this.state.info.componentStack}</pre>
          )}
          <div style={{ marginTop: 12, display: 'flex', gap: 8 }}>
            <button className="btn" onClick={() => location.reload()}>Reload</button>
            <button className="btn-outline" onClick={reset}>Reset local state & reload</button>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}

// ---------- Helpers ----------
const uuid = () =>
  (globalThis.crypto?.randomUUID?.()) ||
  (Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10))

function parseJoinInput(input = '') {
  try {
    if (/^https?:\/\//i.test(input)) {
      const u = new URL(input)
      const id = u.pathname.split('/').filter(Boolean).pop() || u.searchParams.get('id')
      const token = u.searchParams.get('token') || ''
      return { id, token }
    }
  } catch {}
  const parts = input.split('?')
  const idPart = parts[0]
  const qs = parts[1]
  const sp = new URLSearchParams(qs || '')
  return { id: (idPart || '').trim(), token: sp.get('token') || '' }
}

const safeClone = (v) => {
  try { return structuredClone(v) } catch { try { return JSON.parse(JSON.stringify(v)) } catch { return v } }
}

/* ================= META GUARDS (client) ================= */
function deepFixMeta(obj, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 6) return obj
  if (Object.prototype.hasOwnProperty.call(obj, 'meta')) {
    const v = obj.meta
    if (v === undefined || v === null) obj.meta = {}
  }
  if (obj.value && typeof obj.value === 'object' && Object.prototype.hasOwnProperty.call(obj.value, 'meta')) {
    const v = obj.value.meta
    if (v === undefined || v === null) obj.value.meta = {}
  }
  for (const k in obj) {
    if (!Object.prototype.hasOwnProperty.call(obj, k)) continue
    const v = obj[k]
    if (v && typeof v === 'object') deepFixMeta(v, depth + 1)
  }
  return obj
}

function sanitizeChangeSet(changesIn) {
  const changes = safeClone(changesIn)
  if (!changes) return changes
  if (changes.added) {
    const list = Array.isArray(changes.added) ? changes.added : Object.values(changes.added)
    list.forEach((rec) => deepFixMeta(rec))
  }
  if (changes.updated) {
    Object.values(changes.updated).forEach((u) => {
      if (u?.next) deepFixMeta(u.next)
      if (u?.prev) deepFixMeta(u.prev)
    })
  }
  return changes
}

function sanitizeSnapshot(snapIn) {
  const c = safeClone(snapIn)
  if (!c) return snapIn
  const r1 = c?.store?.records
  const r2 = c?.records
  let recs = []
  if (Array.isArray(r1)) recs = r1
  else if (r1 && typeof r1 === 'object') recs = Object.values(r1)
  else if (Array.isArray(r2)) recs = r2
  else if (r2 && typeof r2 === 'object') recs = Object.values(r2)
  recs.forEach((rec) => deepFixMeta(rec))
  if (c.document && (c.document.meta === undefined || c.document.meta === null)) c.document.meta = {}
  return c
}

function mergeRemote(editor, rawChanges) {
  const fixed = sanitizeChangeSet(rawChanges) || {}
  try {
    editor.store.mergeRemoteChanges(() => {
      const added   = Array.isArray(fixed.added) ? fixed.added : Object.values(fixed.added || {})
      const updated = Object.values(fixed.updated || {})
      const removed = Array.isArray(fixed.removed) ? fixed.removed : Object.values(fixed.removed || {})
      for (const rec of added) if (rec) editor.store.put(rec)
      for (const upd of updated) if (upd?.next) editor.store.put(upd.next)
      for (const recOrId of removed) {
        const id = typeof recOrId === 'string' ? recOrId : recOrId?.id
        if (id && editor.store.remove) editor.store.remove(id)
      }
    })
    return
  } catch (e) { console.warn('[mergeRemote guarded] fallback', e) }
  try { editor.store.mergeRemoteChanges(fixed) } catch (e2) { console.error('[mergeRemote] failed', e2, fixed) }
}

// ---------- Tiny AI dialog ----------
function AIDialog({ open, onClose, onAsk, busy, answer, setPrompt, prompt }) {
  if (!open) return null
  return (
    <div style={{
      position:'fixed', inset:0, background:'rgba(0,0,0,0.35)',
      display:'grid', placeItems:'center', zIndex:4000
    }}>
      <div style={{
        width:480, maxWidth:'90vw',
        background:'#fff', color:'#111',
        borderRadius:12, boxShadow:'0 16px 48px rgba(0,0,0,0.2)',
        padding:16
      }}>
        <h3 style={{ margin: '4px 0 8px', fontWeight: 700 }}>Ask AI</h3>

        <div style={{ display:'flex', gap:8, marginBottom:8, flexWrap:'wrap' }}>
          <button className="btn-outline" onClick={() => setPrompt('Summarize the recent discussion and key decisions.')}>Summarize</button>
          <button className="btn-outline" onClick={() => setPrompt('List action items with owners and due dates if mentioned.')}>Extract tasks</button>
          <button className="btn-outline" onClick={() => setPrompt('Suggest next steps for the team based on the current board context.')}>Next steps</button>
        </div>

        <textarea
          value={prompt}
          onChange={(e)=>setPrompt(e.target.value)}
          rows={4}
          style={{ width:'100%', padding:8, border:'1px solid #ddd', borderRadius:8 }}
          placeholder="Ask anything about this board (the last chat messages are included as context)…"
        />

        <div style={{ marginTop:10, display:'flex', gap:8, justifyContent:'flex-end' }}>
          <button className="btn-outline" onClick={onClose} disabled={busy}>Close</button>
          <button className="btn" onClick={onAsk} disabled={busy || !prompt.trim()}>{busy ? 'Thinking…' : 'Ask'}</button>
        </div>

        {answer && (
          <div style={{ marginTop:12, padding:10, background:'#f6f7f9', borderRadius:8, maxHeight:240, overflow:'auto', whiteSpace:'pre-wrap' }}>
            {answer}
          </div>
        )}
      </div>
    </div>
  )
}

// ---------- Lobby ----------
function Lobby({ me, onEnter }) {
  const [joinValue, setJoinValue] = useState('')
  function joinBoard(e) {
    e.preventDefault()
    const { id, token } = parseJoinInput(joinValue)
    if (!id) return alert('Enter a valid board id or link.')
    onEnter({ id, token })
  }
  return (
    <div className="min-h-screen p-6">
      <div className="max-w-5xl mx-auto space-y-6">
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div className="text-xl font-semibold">Welcome, {me.name || me.email}</div>
          <form onSubmit={joinBoard} className="flex gap-2 w-full md:w-[560px]">
            <input
              className="input flex-1"
              placeholder="Paste room link or enter Board ID (optionally ?token=...)"
              value={joinValue}
              onChange={(e) => setJoinValue(e.target.value)}
            />
            <button className="btn" type="submit">Join</button>
          </form>
        </div>
        <BoardsList onOpen={onEnter} />
      </div>
    </div>
  )
}

// ---------- Board ----------
function BoardInner({ boardId, token, me }) {
  const [editor, setEditor] = useState(null)
  const [socket, setSocket] = useState(null)

  const [chatOpen, setChatOpen] = useState(false)
  const [inCall, setInCall] = useState(false)
  const [shareOpen, setShareOpen] = useState(false)

  // AI UI
  const [aiOpen, setAiOpen] = useState(false)
  const [aiBusy, setAiBusy] = useState(false)
  const [aiPrompt, setAiPrompt] = useState('')
  const [aiAnswer, setAiAnswer] = useState('')

  // role map
  const [rolesMap, setRolesMap] = useState({}) // { userId: 'owner'|'editor'|'viewer' }

  // local chat cache
  const historyKey = useMemo(() => 'wb:chat:' + boardId, [boardId])
  const [chatHistory, setChatHistory] = useState(() => {
    try { const raw = localStorage.getItem(historyKey); return raw ? JSON.parse(raw) : [] } catch { return [] }
  })
  const [unread, setUnread] = useState(0)
  useEffect(() => { try { localStorage.setItem(historyKey, JSON.stringify(chatHistory.slice(-2000))) } catch {} }, [chatHistory, historyKey])

  // ---- socket (base namespace) + join room + announce presence ----
  useEffect(() => {
    if (!boardId) return
    const s = io(SERVER_URL, {
      withCredentials: true,
      transports: ['websocket'],
      path: '/socket.io'
    })
    s.on('connect', () => {
      console.log('[socket] connected', s.id)
      s.emit('room:join', { boardId, token }, (res) => {
        if (!res?.ok) {
          console.warn('[room:join] failed:', res?.error)
        } else {
          // Announce presence AFTER join so everyone (including you) sees avatars
          s.emit('presence:join', { id: me.id, name: me.name || 'User', color: me.color || '#7c3aed', boardId })
        }
        // if we were already in a call, announce again so newcomers see us
        if (inCall) {
          s.emit('call:hello', { boardId, userId: me.id, name: me.name })
        }
      })
    })
    s.on('connect_error', (e) => console.warn('[socket] connect_error', e?.message || e))
    setSocket(s)
    return () => s.disconnect()
  }, [boardId, token, inCall, me.id, me.name, me.color])

  // load members -> roles
  useEffect(() => {
    let stopped = false
    ;(async () => {
      try {
        const r = await apiFetch('/api/boards/' + boardId + '/members')
        if (!r.ok) return
        const arr = await r.json()
        if (stopped) return
        const m = {}
        for (const it of arr) m[it.userId] = it.role
        setRolesMap(m)
      } catch {}
    })()
    return () => { stopped = true }
  }, [boardId])

  // ---------- TLDraw realtime ----------
  const hasLoadedSnapshotRef = useRef(false)
  const outQueueRef = useRef([])
  const outTimerRef = useRef(null)

  // initial load + ask server for latest snapshot
  useEffect(() => {
    if (!editor || !socket) return
    ;(async () => {
      try {
        const url = token ? '/api/boards/' + boardId + '?token=' + encodeURIComponent(token) : '/api/boards/' + boardId
        const r = await apiFetch(url)
        if (r.ok) {
          const b = await r.json().catch(async () => {
            const t = await r.text(); throw new Error('Invalid JSON from /api/boards: ' + (t ? t.slice(0,120) : ''))
          })
          if (b?.document?.tldraw && !hasLoadedSnapshotRef.current) {
            requestAnimationFrame(() => {
              try {
                const fixed = sanitizeSnapshot(b.document.tldraw)
                editor.batch(() => {
                  editor.store.loadSnapshot(fixed)
                })
                hasLoadedSnapshotRef.current = true
              } catch (e) {
                console.warn('[loadSnapshot initial] failed', e)
              }
            })
          }
        }
        socket.emit('board:snapshot:request', { boardId })
      } catch (e) {
        console.warn('Board fetch error', e)
      }
    })()
  }, [editor, socket, boardId, token])

  // patch store: guard put + mergeRemoteChanges + heal current snapshot
  useEffect(() => {
    if (!editor) return
    try {
      const store = editor.store

      const origPut = store.put.bind(store)
      store.put = (rec) => {
        try { deepFixMeta(rec) } catch {}
        return origPut(rec)
      }

      if (typeof store.mergeRemoteChanges === 'function') {
        const origMRC = store.mergeRemoteChanges.bind(store)
        store.mergeRemoteChanges = (arg) => {
          if (typeof arg === 'function') {
            return origMRC(arg)
          } else {
            const fixed = sanitizeChangeSet(arg)
            return origMRC(fixed)
          }
        }
      }

      if (typeof store.getSnapshot === 'function') {
        const snap = store.getSnapshot()
        if (snap) {
          const fixed = sanitizeSnapshot(snap)
          store.loadSnapshot(fixed)
        }
      }
    } catch (e) {
      console.warn('[store harden]', e)
    }
  }, [editor])

  // handle snapshot + ops
  useEffect(() => {
    if (!editor || !socket) return

    const onSnapshot = ({ doc }) => {
      if (doc?.tldraw && !hasLoadedSnapshotRef.current) {
        requestAnimationFrame(() => {
          try {
            editor.batch(() => {
              editor.store.loadSnapshot(sanitizeSnapshot(doc.tldraw))
            })
            hasLoadedSnapshotRef.current = true
          } catch (e) {
            console.warn('[snapshot:response] load failed', e)
          }
        })
      }
    }

    const onOps = (payload = {}) => {
      const ops = Array.isArray(payload) ? payload : (payload.ops || [])
      const snapshot = Array.isArray(payload) ? null : payload.snapshot

      if (snapshot && !hasLoadedSnapshotRef.current) {
        requestAnimationFrame(() => {
          try {
            editor.batch(() => editor.store.loadSnapshot(sanitizeSnapshot(snapshot)))
            hasLoadedSnapshotRef.current = true
          } catch (e) { console.warn('[snapshot in ops] load failed', e) }
        })
      }

      if (!ops?.length) return
      if (!editor.inputs) { requestAnimationFrame(() => onOps(payload)); return }

      try {
        const fixedOps = ops.map(o => o?.changes ? { ...o, changes: sanitizeChangeSet(o.changes) } : o)
        editor.batch(() => {
          for (const op of fixedOps) {
            if (op?.changes) mergeRemote(editor, op.changes)
          }
        })
      } catch (e) {
        console.error('[apply remote ops] failed', e)
      }
    }

    socket.on('board:snapshot:response', onSnapshot)
    socket.on('board:ops', onOps)
    return () => {
      socket.off('board:snapshot:response', onSnapshot)
      socket.off('board:ops', onOps)
    }
  }, [editor, socket])

  // outgoing ops micro-batch
  useEffect(() => {
    if (!editor || !socket) return

    const flush = () => {
      outTimerRef.current = null
      const batch = outQueueRef.current.splice(0)
      if (!batch.length) return
      const now = Date.now()
      const ops = batch.map(changes => ({ id: uuid(), ts: now, userId: me.id, changes }))
      socket.emit('board:ops', { boardId, ops })
    }
    const schedule = () => {
      if (outTimerRef.current) return
      outTimerRef.current = setTimeout(flush, 50)
    }

    const unlisten = editor.store.listen(
      (entry) => {
        if (entry.source !== 'user') return
        const fixed = sanitizeChangeSet(entry.changes)
        outQueueRef.current.push(fixed)
        schedule()
      },
      { source: 'user' }
    )

    return () => {
      try { unlisten() } catch {}
      if (outTimerRef.current) { clearTimeout(outTimerRef.current); outTimerRef.current = null }
    }
  }, [editor, socket, boardId, me.id])

  // chat -> unread (top-right bubble)
  useEffect(() => {
    if (!socket) return
    const onMsg = (msg) => {
      const rec = { id: msg.id || uuid(), name: msg.name || 'Unknown', text: msg.text || '', ts: msg.ts || Date.now(), userId: msg.userId || null }
      setChatHistory((h) => [...h, rec])
      if (!chatOpen) setUnread((u) => u + 1)
    }
    socket.on('chat:message', onMsg)
    return () => socket.off('chat:message', onMsg)
  }, [socket, chatOpen])

  // VoiceCall peer discovery
  useEffect(() => {
    if (!socket) return
    if (inCall) {
      const t = setTimeout(() => {
        socket.emit('call:hello', { boardId, userId: me.id, name: me.name })
      }, 100)
      return () => clearTimeout(t)
    } else {
      socket.emit('call:leave', { boardId, userId: me.id })
    }
  }, [inCall, socket, boardId, me.id, me.name])

  const boardUrl = useMemo(() => {
    const base = location.origin + location.pathname
    const sp = new URLSearchParams()
    sp.set('id', boardId)
    if (token) sp.set('token', token)
    return base + '?' + sp.toString()
  }, [boardId, token])

  const onOpenChat = () => { setChatOpen(true); setUnread(0) }
  const onShare = async () => {
    if (!editor) return
    try {
      const png = await exportBlob({ editor, format: 'png', scale: 2, background: true })
      const handled = await tryWebShare({ blob: png, filename: 'whiteboard.png', boardUrl, message: 'Check out this whiteboard' })
      if (handled) return
    } catch {}
    setShareOpen(true)
  }
  const onToggleCall = () => setInCall((v) => !v)

  // Presence overlay
  const overlayRef = useRef(null)
  const presence = usePresence(
    socket,
    editor,
    { id: me.id, name: me.name, color: me.color || '#7c3aed' },
    {
      boardId,
      getBounds: () => (overlayRef.current && overlayRef.current.getBoundingClientRect()) || { left: 0, top: 0 }
    }
  )
  const users = presence?.users ?? []
  const selections = presence?.selections ?? {}
  const liveCursors = presence?.cursors ?? (presence?.cursorsRef ? presence.cursorsRef.current : {}) ?? {}

  // Helper: is a user's cursor currently active? (works even if cursors are keyed by socketId)
  const isActive = (userId) => {
    return !!Object.values(liveCursors || {}).find((c) => c.id === userId && c.active)
  }

  const roleOf = (id) => rolesMap[id] || 'viewer'

  const avatarUsers = useMemo(() => {
    const list = users.slice()
    const hasMe = list.some(u => u.id === me.id)
    if (!hasMe && me?.id) list.unshift({ id: me.id, name: me.name, color: me.color })
    return list.map(u => ({ ...u, role: roleOf(u.id) }))
  }, [users, me, rolesMap])

  // people popover
  const [showPeople, setShowPeople] = useState(false)
  useEffect(() => {
    const close = (e) => {
      const pop = document.getElementById('people-popover')
      if (!pop) return
      if (!pop.contains(e.target)) setShowPeople(false)
    }
    if (showPeople) document.addEventListener('pointerdown', close, true)
    return () => document.removeEventListener('pointerdown', close, true)
  }, [showPeople])

  // FAB offset helper
  const [offsetPx, setOffsetPx] = useState(20)
  useEffect(() => {
    function calc() {
      const chat = chatOpen ? document.getElementById('chat-panel') : null
      const voice = document.getElementById('voice-panel')
      const gap = 16, base = 20
      const needAbove = (el) => { if (!el) return 0; const r = el.getBoundingClientRect(); return Math.max(0, window.innerHeight - r.top + gap) }
      setOffsetPx(Math.max(needAbove(chat), needAbove(voice), base))
    }
    const onMini = () => calc()
    window.addEventListener('resize', calc)
    window.addEventListener('scroll', calc, true)
    window.addEventListener('vc-minimize-changed', onMini)
    calc()
    return () => {
      window.removeEventListener('resize', calc)
      window.removeEventListener('scroll', calc, true)
      window.removeEventListener('vc-minimize-changed', onMini)
    }
  }, [chatOpen, inCall])

  useEffect(() => {
    const handler = () => {
      const minimized = !!window.__vcMinimized
      const on = chatOpen || shareOpen || (inCall && !minimized)
      document.body.classList.toggle('overlay-open', on)
    }
    handler()
    window.addEventListener('vc-minimize-changed', handler)
    return () => {
      window.removeEventListener('vc-minimize-changed', handler)
      document.body.classList.remove('overlay-open')
    }
  }, [chatOpen, inCall, shareOpen])

  const overlayOpen = chatOpen || shareOpen || inCall

  // Ask AI
  async function askAI() {
    setAiBusy(true)
    setAiAnswer('')
    try {
      const recent = chatHistory.slice(-30)
      const messages = [
        { role: 'system', content: 'You are an assistant helping people collaborate on a whiteboard. Be concise and actionable.' },
        ...recent.map(m => ({ role: m.userId === me.id ? 'user' : 'assistant', content: (m.name || 'User') + ': ' + (m.text || '') })),
        { role: 'user', content: aiPrompt }
      ]
      const res = await apiFetch('/api/ai/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages }),
      })
      const ct = (res.headers.get('content-type') || '').toLowerCase()
      let data
      if (ct.indexOf('application/json') >= 0) {
        data = await res.json().catch(() => ({}))
      } else {
        const t = await res.text()
        throw new Error((t && t.slice(0, 200)) || ('AI endpoint returned ' + res.status))
      }
      if (!res.ok || !data?.ok) throw new Error(data?.error || ('AI error (' + res.status + ')'))
      const answer = String(data.text || '')
      setAiAnswer(answer)

      if (socket) {
        socket.emit('chat:message', {
          id: uuid(),
          userId: 'ai',
          name: 'AI Assistant',
          text: answer,
          ts: Date.now(),
        })
      }
    } catch (e) {
      setAiAnswer('Error: ' + (e.message || String(e)))
    } finally {
      setAiBusy(false)
    }
  }

  // === UI ===
  return (
    <>
      <div className={'h-screen ' + (overlayOpen ? 'hide-colors' : '')} style={{ position: 'relative' }}>
        <Tldraw
          inferDarkMode
          className="h-full"
          onMount={(ed) => {
            setEditor(ed)
            try {
              const snap = ed.store.getSnapshot?.()
              if (snap) ed.store.loadSnapshot(sanitizeSnapshot(snap))
            } catch {}
          }}
        />

        {/* Presence Overlay */}
        <div ref={overlayRef} style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
          {/* Avatars with +N popover (with role labels) */}
          <div
            title="Participants"
            style={{
              position: 'absolute',
              top: 8,
              right: 170,
              display: 'flex',
              gap: 8,
              zIndex: 2000,
              pointerEvents: 'auto',
              alignItems: 'center',
            }}
          >
            {avatarUsers.slice(0, 2).map(u => {
              const active = isActive(u.id)
              const roleEmoji = u.role === 'owner' ? '👑' : u.role === 'editor' ? '✏️' : '👁️'
              const roleText  = u.role === 'owner' ? 'Owner' : u.role === 'editor' ? 'Editor' : 'Viewer'
              return (
                <div key={u.id} title={`${u.name} · ${roleText}`} style={{ position: 'relative', textAlign:'center' }}>
                  <div style={{ position:'relative', display:'inline-block' }}>
                    <img
                      src={avatarUrlFor(u)}
                      alt={u.name}
                      width={48}
                      height={48}
                      style={{
                        width: 48, height: 48, borderRadius: '50%',
                        display: 'block',
                        boxShadow: active ? ('0 0 0 3px ' + (u.color || '#10b981')) : '0 0 0 1px rgba(0,0,0,0.2)',
                        background: '#fff'
                      }}
                    />
                    <div style={{
                      position:'absolute', bottom:-2, right:-2,
                      fontSize: 11, lineHeight:'14px',
                      background:'rgba(255,255,255,0.95)',
                      border:'1px solid rgba(0,0,0,0.15)',
                      borderRadius: 8, padding:'0 4px'
                    }}>
                      {roleEmoji}
                    </div>
                  </div>
                  <div style={{
                    fontSize: 10, marginTop: 2,
                    background:'rgba(255,255,255,0.9)',
                    border:'1px solid rgba(0,0,0,0.1)',
                    borderRadius: 6, padding:'0 4px',
                    display:'inline-block'
                  }}>
                    {roleText}
                  </div>
                </div>
              )
            })}
            {avatarUsers.length > 2 && (
              <button
                onClick={() => setShowPeople(v => !v)}
                style={{
                  width: 48, height: 48, borderRadius: '50%',
                  border: '1px solid rgba(0,0,0,0.2)',
                  background: 'rgba(255,255,255,0.95)',
                  cursor: 'pointer',
                  fontWeight: 600
                }}
              >
                {'+' + (avatarUsers.length - 2)}
              </button>
            )}

            {showPeople && (
              <div
                id="people-popover"
                style={{
                  position: 'absolute', top: 56, right: 0,
                  width: 280, maxHeight: 340, overflow: 'auto',
                  background: 'rgba(255,255,255,0.98)', color: '#111',
                  border: '1px solid rgba(0,0,0,0.15)', borderRadius: 8,
                  padding: 8, boxShadow: '0 8px 24px rgba(0,0,0,0.15)',
                  pointerEvents: 'auto',
                }}
              >
                {avatarUsers.map(u => {
                  const active = isActive(u.id)
                  const badge = u.role === 'owner' ? '👑 Owner' : u.role === 'editor' ? '✏️ Editor' : '👁️ Viewer'
                  return (
                    <div key={u.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 4px' }}>
                      <img
                        src={avatarUrlFor(u)}
                        alt={u.name}
                        width={32}
                        height={32}
                        style={{
                          width: 32, height: 32, borderRadius: '50%',
                          boxShadow: active ? ('0 0 0 2px ' + (u.color || '#10b981')) : '0 0 0 1px rgba(0,0,0,0.2)',
                          background: '#fff'
                        }}
                      />
                      <div style={{ flex: 1 }}>
                        <div style={{ fontSize: 13, fontWeight: 600 }}>{u.name}</div>
                        <div style={{ fontSize: 11, opacity: 0.7 }}>{badge}{u.id === me.id ? ' · You' : ''}</div>
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </div>

          {/* Live cursors */}
          {Object.values(liveCursors || {}).map((c) => (
            <div key={c.id} style={{
              position:'absolute', left:(c.x != null ? c.x : -9999), top:(c.y != null ? c.y : -9999),
              transform:'translate(-50%,-50%)', pointerEvents:'none', zIndex:1500
            }}>
              <div style={{
                width:12, height:12, borderRadius:'50%', background:c.color, border:'2px solid #fff',
                boxShadow: c.active ? ('0 0 8px 2px ' + c.color) : '0 0 2px rgba(0,0,0,0.3)'
              }} />
              <div style={{
                position:'absolute', top:14, left:'50%', transform:'translateX(-50%)',
                color:c.color, fontSize:'0.7rem', background:'rgba(255,255,255,0.95)', padding:'0 3px', borderRadius:3
              }}>{c.name}</div>
            </div>
          ))}

          {/* Selection rectangles */}
          {editor && Object.values(selections || {}).map(sel =>
            (sel.shapes || []).map(id => {
              const b = editor.getShapeBounds?.(id)
              if (!b) return null
              const key = (sel.userId || sel.id || 'u') + '-' + id
              return (
                <div key={key} style={{
                  position:'absolute', left:b.minX, top:b.minY, width:b.width, height:b.height,
                  border: '2px solid ' + (sel.color || '#3b82f6'), borderRadius:4, pointerEvents:'none', zIndex:1200
                }}>
                  <span style={{
                    position:'absolute', top:-16, left:0, background:(sel.color || '#3b82f6'), color:'#fff',
                    padding:'1px 4px', borderRadius:3, fontSize:'0.6rem'
                  }}>{sel.name}</span>
                </div>
              )
            })
          )}
        </div>

        {/* Ask AI floating button */}
        <button
          onClick={() => { setAiOpen(true); setAiAnswer('') }}
          style={{
            position:'absolute', bottom:20, left:20, zIndex:2100,
            padding:'10px 14px', borderRadius:999,
            border:'1px solid rgba(0,0,0,0.1)',
            background:'rgba(255,255,255,0.96)', cursor:'pointer',
            boxShadow:'0 8px 18px rgba(0,0,0,0.12)', fontWeight:700
          }}
          title="Ask AI"
        >
          {'🤖 Ask AI'}
        </button>
      </div>

      <FabCluster
        onOpenChat={onOpenChat}
        onShare={onShare}
        onToggleCall={onToggleCall}
        inCall={inCall}
        offset={Math.max(5, Math.round(offsetPx / 4))}
        unreadCount={unread}
        overlayOpen={overlayOpen}
      />

      <div id="chat-panel">
        <ChatPanel
          socket={socket}
          boardId={boardId}
          token={token}
          me={me}
          open={chatOpen}
          onClose={() => setChatOpen(false)}
          history={chatHistory}
        />
      </div>

      {inCall && (
        <div id="voice-panel">
          <VoiceCall socket={socket} me={me} boardId={boardId} onEnd={() => setInCall(false)} />
        </div>
      )}

      {editor && (
        <ShareDialog
          open={shareOpen}
          onClose={() => setShareOpen(false)}
          editor={editor}
          boardUrl={boardUrl}
          defaultFormat="png"
        />
      )}

      {/* AI Dialog */}
      <AIDialog
        open={aiOpen}
        onClose={() => setAiOpen(false)}
        onAsk={askAI}
        busy={aiBusy}
        answer={aiAnswer}
        prompt={aiPrompt}
        setPrompt={setAiPrompt}
      />
    </>
  )
}

// ---------- Root ----------
function AppInner() {
  const urlParams = new URLSearchParams(location.search)
  const initialId = urlParams.get('id') || ''
  const initialToken = urlParams.get('token') || ''
  const [route, setRoute] = useState({ id: initialId, token: initialToken })

  const [me, setMe] = useState({ id: '', email: '', name: '', color: '#7c3aed' })
  const [auth, setAuth] = useState({ identifier: '', password: '', mode: 'signin', name: '' })
  const [err, setErr] = useState('')

  useEffect(() => {
    apiFetch('/api/me')
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((u) => setMe({ id: u.id, email: u.email, name: u.name, color: u.color }))
      .catch(() => {})
  }, [])

  async function submit(e) {
    e.preventDefault()
    setErr('')
    const path = auth.mode === 'signup' ? '/api/auth/signup' : '/api/auth/signin'
    const body = auth.mode === 'signup'
      ? { name: auth.name || 'New user', email: auth.identifier, password: auth.password }
      : { identifier: auth.identifier, password: auth.password }

    const res = await apiFetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (res.ok) {
      const u = await apiFetch('/api/me').then((r) => r.json())
      setMe({ id: u.id, email: u.email, name: u.name, color: u.color })
    } else {
      const txt = await res.text().catch(()=> '')
      setErr(txt || 'Auth failed')
    }
  }

  if (!me.id) {
    return (
      <div className="min-h-screen grid place-items-center p-6">
        <form onSubmit={submit} className="w-full max-w-sm space-y-3 bg-white/70 dark:bg-zinc-900/70 p-6 rounded-xl shadow">
          <h1 className="text-xl font-semibold">
            {auth.mode === 'signup' ? 'Create account' : 'Welcome back'}
          </h1>

          {auth.mode === 'signup' ? (
            <>
              <input
                className="input w-full"
                placeholder="Full name"
                value={auth.name}
                onChange={(e) => setAuth({ ...auth, name: e.target.value })}
                autoComplete="name"
                required
              />
              <input
                className="input w-full"
                placeholder="Email"
                autoComplete="email"
                value={auth.identifier}
                onChange={(e) => setAuth({ ...auth, identifier: e.target.value })}
                required
              />
            </>
          ) : (
            <input
              className="input w-full"
              placeholder="Email or username"
              autoComplete="username"
              value={auth.identifier}
              onChange={(e) => setAuth({ ...auth, identifier: e.target.value })}
              required
            />
          )}

          <input
            type="password"
            className="input w-full"
            placeholder="Password"
            autoComplete={auth.mode === 'signup' ? 'new-password' : 'current-password'}
            value={auth.password}
            onChange={(e) => setAuth({ ...auth, password: e.target.value })}
            required
          />

          {err && <p className="text-sm text-red-600">{err}</p>}

          <button className="btn w-full">{auth.mode === 'signup' ? 'Sign up' : 'Sign in'}</button>
          <button
            type="button"
            className="btn-outline w-full"
            onClick={() => setAuth((a) => ({ identifier: '', password: '', name: '', mode: a.mode === 'signup' ? 'signin' : 'signup' }))}
          >
            Switch to {auth.mode === 'signup' ? 'Sign in' : 'Sign up'}
          </button>
        </form>
      </div>
    )
  }

  if (!route.id) {
    return (
      <Lobby
        me={me}
        onEnter={({ id, token }) => {
          const sp = new URLSearchParams()
          sp.set('id', id)
          if (token) sp.set('token', token)
          const next = location.pathname + '?' + sp.toString()
          window.history.pushState({}, '', next)
          setRoute({ id, token: token || '' })
        }}
      />
    )
  }

  return <BoardInner boardId={route.id} token={route.token} me={me} />
}

export default function App() {
  return (
    <ErrorBoundary>
      <AppInner />
    </ErrorBoundary>
  )
}
