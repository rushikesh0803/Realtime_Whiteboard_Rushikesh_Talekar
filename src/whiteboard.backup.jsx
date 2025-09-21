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

// Avatar image (stable per user)
function avatarUrlFor(user) {
  const seed = encodeURIComponent(String(user?.id || user?.name || 'anon'))
  return `https://api.dicebear.com/7.x/adventurer/svg?seed=${seed}&radius=50&backgroundType=gradientLinear`
}

// ---------- Error Boundary ----------
class ErrorBoundary extends React.Component {
  constructor(p) { super(p); this.state = { error: null, info: null } }
  static getDerivedStateFromError(error) { return { error } }
  componentDidCatch(error, info) { console.error('[UI ERROR]', error, info); this.setState({ info }) }
  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: 16, fontFamily: 'system-ui' }}>
          <h2>Something went wrong.</h2>
          <pre style={{ whiteSpace: 'pre-wrap', background: '#1111', padding: 12, borderRadius: 8 }}>
            {String(this.state.error?.message || this.state.error)}
          </pre>
          {this.state.info?.componentStack && (
            <pre style={{ whiteSpace: 'pre-wrap', opacity: 0.7 }}>{this.state.info.componentStack}</pre>
          )}
        </div>
      )
    }
    return this.props.children
  }
}

// ---------- Helpers ----------
const uuid = () =>
  (globalThis.crypto?.randomUUID?.()) ||
  `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`

function parseJoinInput(input = '') {
  try {
    if (/^https?:\/\//i.test(input)) {
      const u = new URL(input)
      const id = u.pathname.split('/').filter(Boolean).pop() || u.searchParams.get('id')
      const token = u.searchParams.get('token') || ''
      return { id, token }
    }
  } catch {}
  const [idPart, qs] = input.split('?')
  const sp = new URLSearchParams(qs || '')
  return { id: (idPart || '').trim(), token: sp.get('token') || '' }
}

// Deep clone (safe) then normalize TL document.meta = {}
const safeClone = (v) => {
  try { return structuredClone(v) } catch { try { return JSON.parse(JSON.stringify(v)) } catch { return v } }
}

// Normalize a TL record so it never has undefined meta
function ensureDocMetaOnRecord(rec) {
  if (!rec) return
  const type = rec.typeName || rec.type
  if (type === 'tl_document' || type === 'document') {
    if (rec.meta === undefined || rec.meta === null) rec.meta = {}
    if (rec.value && typeof rec.value === 'object' && (rec.value.meta == null)) rec.value.meta = {}
  }
}

// Sanitize a TL change-set (drop undefined; ensure meta)
function sanitizeChangeSet(ch) {
  const changes = safeClone(ch)
  if (!changes) return changes

  if (changes.added) {
    const list = Array.isArray(changes.added) ? changes.added : Object.values(changes.added)
    list.forEach(ensureDocMetaOnRecord)
  }

  if (changes.updated) {
    const list = Object.values(changes.updated)
    list.forEach((u) => {
      if (u?.next) ensureDocMetaOnRecord(u.next)
      if (u?.prev) ensureDocMetaOnRecord(u.prev)
    })
  }
  return changes
}

// Sanitize a TL snapshot (records array or map)
function sanitizeSnapshot(snap) {
  const c = safeClone(snap)
  if (!c) return snap

  let recs = []
  const r1 = c?.store?.records
  const r2 = c?.records

  if (Array.isArray(r1)) recs = r1
  else if (r1 && typeof r1 === 'object') recs = Object.values(r1)
  else if (Array.isArray(r2)) recs = r2
  else if (r2 && typeof r2 === 'object') recs = Object.values(r2)

  recs.forEach(ensureDocMetaOnRecord)

  // Some dumps also have document meta here:
  if (c.document && (c.document.meta == null)) c.document.meta = {}

  return c
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

  // local chat cache
  const historyKey = useMemo(() => `wb:chat:${boardId}`, [boardId])
  const [chatHistory, setChatHistory] = useState(() => {
    try { const raw = localStorage.getItem(historyKey); return raw ? JSON.parse(raw) : [] } catch { return [] }
  })
  const [unread, setUnread] = useState(0)
  useEffect(() => { try { localStorage.setItem(historyKey, JSON.stringify(chatHistory.slice(-2000))) } catch {} }, [chatHistory, historyKey])

  // Socket
  useEffect(() => {
    if (!boardId) return
    const s = io(`${SERVER_URL}/room:board:${boardId}`, { withCredentials: true, transports: ['websocket'] })
    s.on('connect', () => console.log('[socket] connected', s.id, 'room=room:board:' + boardId))
    setSocket(s)
    return () => s.disconnect()
  }, [boardId])

  // ---------- TLDraw realtime ----------
  const hasLoadedSnapshotRef = useRef(false)
  const outQueueRef = useRef([])
  const outTimerRef = useRef(null)

  // initial board load + ask server for snapshot
  useEffect(() => {
    if (!editor || !socket) return
    ;(async () => {
      try {
        const url = token ? `/api/boards/${boardId}?token=${encodeURIComponent(token)}` : `/api/boards/${boardId}`
        const r = await apiFetch(url)
        if (r.ok) {
          const b = await r.json()
          if (b?.document?.tldraw && !hasLoadedSnapshotRef.current) {
            requestAnimationFrame(() => {
              try {
                editor.batch(() => {
                  editor.store.loadSnapshot(sanitizeSnapshot(b.document.tldraw))
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

  // handle snapshot + ops (apply only when editor is ready)
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
        editor.batch(() => {
          for (const op of ops) {
            if (op?.changes) {
              const fixed = sanitizeChangeSet(op.changes)
              editor.store.mergeRemoteChanges(fixed)
            }
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

  // outgoing ops micro-batch (reduce lag) + sanitize
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
      outTimerRef.current = setTimeout(flush, 50) // ~20 fps network
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

  // chat bubble -> unread
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

  const boardUrl = useMemo(() => {
    const base = `${location.origin}${location.pathname}`
    const sp = new URLSearchParams()
    sp.set('id', boardId)
    if (token) sp.set('token', token)
    return `${base}?${sp.toString()}`
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

  // ---------- Presence overlay ----------
  const overlayRef = useRef(null)
  const { users, cursors, selections } = usePresence(
    socket,
    editor,
    { id: me.id, name: me.name, color: me.color || '#7c3aed' },
    { getBounds: () => overlayRef.current?.getBoundingClientRect() || { left: 0, top: 0 } }
  )

  const avatarUsers = useMemo(() => {
    const list = [...users]
    const hasMe = list.some(u => u.id === me.id)
    if (!hasMe && me?.id) list.unshift({ id: me.id, name: me.name, color: me.color })
    return list
  }, [users, me])

  // overflow popover
  const [showPeople, setShowPeople] = useState(false)
  const togglePeople = () => setShowPeople(v => !v)
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

  // avatar render helpers
  const MAX_INLINE = 2
  const inlineUsers = avatarUsers.slice(0, MAX_INLINE)
  const overflowUsers = avatarUsers.slice(MAX_INLINE)
  const overflowCount = overflowUsers.length

  return (
    <>
      <div className={`h-screen ${overlayOpen ? 'hide-colors' : ''}`} style={{ position: 'relative' }}>
        <Tldraw inferDarkMode className="h-full" onMount={setEditor} />

        {/* Presence Overlay */}
        <div ref={overlayRef} style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
          {/* Avatars with +N */}
          <div
            title="Participants"
            style={{
              position: 'absolute',
              top: 8,
              right: 12,
              display: 'flex',
              gap: 8,
              zIndex: 2000,
              pointerEvents: 'auto',
              alignItems: 'center',
            }}
          >
            {inlineUsers.map(u => {
              const active = !!(cursors && cursors[u.id]?.active)
              const ring = active
                ? `0 0 0 3px ${u.color || '#10b981'}`
                : '0 0 0 1px rgba(0,0,0,0.2)'
              return (
                <div key={u.id} title={u.name} style={{ position: 'relative' }}>
                  <img
                    src={avatarUrlFor(u)}
                    alt={u.name}
                    width={48}
                    height={48}
                    style={{
                      width: 48, height: 48, borderRadius: '50%',
                      display: 'block',
                      boxShadow: ring,
                      background: '#fff'
                    }}
                  />
                </div>
              )
            })}
            {overflowCount > 0 && (
              <button
                onClick={togglePeople}
                style={{
                  width: 48, height: 48, borderRadius: '50%',
                  border: '1px solid rgba(0,0,0,0.2)',
                  background: 'rgba(255,255,255,0.95)',
                  cursor: 'pointer',
                  fontWeight: 600
                }}
              >
                +{overflowCount}
              </button>
            )}

            {/* Popover list */}
            {showPeople && (
              <div
                id="people-popover"
                style={{
                  position: 'absolute', top: 56, right: 0,
                  width: 260, maxHeight: 320, overflow: 'auto',
                  background: 'rgba(255,255,255,0.98)', color: '#111',
                  border: '1px solid rgba(0,0,0,0.15)', borderRadius: 8,
                  padding: 8, boxShadow: '0 8px 24px rgba(0,0,0,0.15)',
                  pointerEvents: 'auto',
                }}
              >
                {avatarUsers.map(u => {
                  const active = !!(cursors && cursors[u.id]?.active)
                  const ring = active
                    ? `0 0 0 2px ${u.color || '#10b981'}`
                    : '0 0 0 1px rgba(0,0,0,0.2)'
                  return (
                    <div key={u.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 4px' }}>
                      <img
                        src={avatarUrlFor(u)}
                        alt={u.name}
                        width={32}
                        height={32}
                        style={{
                          width: 32, height: 32, borderRadius: '50%',
                          boxShadow: ring,
                          background: '#fff'
                        }}
                      />
                      <div style={{ flex: 1 }}>
                        <div style={{ fontSize: 13, fontWeight: 600 }}>{u.name}</div>
                        <div style={{ fontSize: 11, opacity: 0.65 }}>{u.id === me.id ? 'You' : 'Participant'}</div>
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </div>

          {/* Live cursors */}
          {Object.values(cursors || {}).map(c => (
            <div key={c.id} style={{
              position:'absolute', left:(c.x ?? -9999), top:(c.y ?? -9999),
              transform:'translate(-50%,-50%)', pointerEvents:'none', zIndex:1500
            }}>
              <div style={{
                width:12, height:12, borderRadius:'50%', background:c.color, border:'2px solid #fff',
                boxShadow: c.active ? `0 0 8px 2px ${c.color}` : '0 0 2px rgba(0,0,0,0.3)'
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
              return (
                <div key={`${sel.userId}-${id}`} style={{
                  position:'absolute', left:b.minX, top:b.minY, width:b.width, height:b.height,
                  border:`2px solid ${sel.color}`, borderRadius:4, pointerEvents:'none', zIndex:1200
                }}>
                  <span style={{
                    position:'absolute', top:-16, left:0, background:sel.color, color:'#fff',
                    padding:'1px 4px', borderRadius:3, fontSize:'0.6rem'
                  }}>{sel.name}</span>
                </div>
              )
            })
          )}
        </div>
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
          const next = `${location.pathname}?${sp.toString()}`
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
