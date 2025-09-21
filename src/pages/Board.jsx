import { useEffect, useRef, useState } from 'react'
import { Tldraw } from '@tldraw/tldraw'
import '@tldraw/tldraw/tldraw.css'

import { getOrCreateBoard, connectBoardSocket, getJson } from '../lib/api'
import usePresence from '../hooks/usePresence'

export default function Board() {
  const [me, setMe] = useState(null)
  const [socket, setSocket] = useState(null)
  const [editor, setEditor] = useState(null)
  const [boardId, setBoardId] = useState(null)
  const overlayRef = useRef(null)

  // bootstrap
  useEffect(() => {
    (async () => {
      try {
        const id = await getOrCreateBoard()
        setBoardId(id)
        const user = await getJson('/api/me')
        setMe(user)

        const s = connectBoardSocket(id, {
          id: user.id, name: user.name || user.email, color: user.color || '#7c3aed',
        })
        // verbose logs
        s.on('connect', () => console.log('[socket] connected', s.id, 'room=room:board:' + id))
        s.on('connect_error', (e) => console.error('[socket] connect_error', e?.message || e))
        s.on('disconnect', (r) => console.warn('[socket] disconnected', r))
        s.onAny((ev, ...args) => {
          if (!['cursor:move'].includes(ev)) console.log('[socket] <=', ev, args?.[0] ?? '')
        })
        setSocket(s)
      } catch (e) {
        console.error('[Board] bootstrap failed:', e)
      }
    })()
  }, [])

  // presence (avatars, cursors, selection boxes)
  const { users, cursors, selections } = usePresence(socket, editor, me || {}, {
    getBounds: () => overlayRef.current?.getBoundingClientRect() || { left: 0, top: 0 },
  })

  // tldraw realtime sync (changes-based)
  useEffect(() => {
    if (!editor || !socket || !me?.id) return

    // load initial snapshot if server has one
    const onSnapshot = (payload) => {
      const doc = payload?.doc
      if (doc?.tldraw) {
        editor.store.loadSnapshot(doc.tldraw)
      }
    }
    socket.on('board:snapshot:response', onSnapshot)

    // ask server for snapshot
    socket.emit('board:snapshot:request', { boardId })

    // apply remote ops
    const onOps = ({ ops = [] }) => {
      for (const op of ops) {
        if (op?.changes) editor.store.mergeRemoteChanges(op.changes)
      }
    }
    socket.on('board:ops', onOps)

    // emit local user edits as ops
    const unlisten = editor.store.listen((entry) => {
      if (entry.source !== 'user') return
      socket.emit('board:ops', {
        boardId,
        ops: [{
          id: crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2),
          ts: Date.now(),
          userId: me.id,
          changes: entry.changes,
        }],
      })
    }, { source: 'user' })

    return () => {
      socket.off('board:ops', onOps)
      socket.off('board:snapshot:response', onSnapshot)
      try { unlisten() } catch {}
    }
  }, [editor, socket, me?.id, boardId])

  return (
    <div style={{ position: 'relative', width: '100vw', height: '100vh' }}>
      {/* Debug pill so you can confirm both tabs share the same board id */}
      {boardId && (
        <div style={{
          position:'absolute', left:10, top:10, zIndex:2000,
          background:'rgba(0,0,0,0.6)', color:'#fff', padding:'4px 8px', borderRadius:6,
          fontSize:12
        }}>
          board: <b>{boardId}</b>
        </div>
      )}

      <Tldraw
        inferDarkMode
        onMount={(ed) => {
          console.log('[TLDraw] editor mounted')
          setEditor(ed)
          // if socket already up, request snapshot once editor exists
          setTimeout(() => socket?.emit('board:snapshot:request', { boardId }), 80)
        }}
      />

      {/* overlay for UI chrome (avatars/cursors/selections) */}
      <div id="tldraw-overlay" ref={overlayRef} style={{ position:'absolute', inset:0, pointerEvents:'none' }}>
        {/* presence avatars */}
        <div style={{
          position:'absolute', top:8, right:80, display:'flex', gap:4, zIndex:1000, pointerEvents:'auto'
        }}>
          {users.map(u => (
            <div key={u.id} title={u.name} style={{
              width:24, height:24, borderRadius:'50%', background:u.color, color:'#fff',
              fontSize:'0.7rem', display:'flex', alignItems:'center', justifyContent:'center',
              boxShadow: cursors[u.id]?.active ? `0 0 8px 2px ${u.color}` : '0 0 2px rgba(0,0,0,0.2)',
              transition:'box-shadow 0.2s'
            }}>{u.name?.[0]?.toUpperCase()}</div>
          ))}
        </div>

        {/* live cursors */}
        {Object.values(cursors).map(c => (
          <div key={c.id} style={{
            position:'absolute', left:(c.x ?? -9999), top:(c.y ?? -9999),
            transform:'translate(-50%,-50%)', pointerEvents:'none', zIndex:2000
          }}>
            <div style={{
              width:12, height:12, borderRadius:'50%', background:c.color, border:'2px solid #fff',
              boxShadow: c.active ? `0 0 8px 2px ${c.color}` : '0 0 2px rgba(0,0,0,0.3)'
            }} />
            <div style={{ position:'absolute', top:14, left:'50%', transform:'translateX(-50%)',
              color:c.color, fontSize:'0.7rem', background:'rgba(255,255,255,0.9)', padding:'0 2px', borderRadius:2
            }}>{c.name}</div>
          </div>
        ))}

        {/* selection boxes with labels */}
        {editor && Object.values(selections).map(sel =>
          (sel.shapes || []).map(id => {
            const b = editor.getShapeBounds?.(id)
            if (!b) return null
            return (
              <div key={`${sel.userId}-${id}`} style={{
                position:'absolute', left:b.minX, top:b.minY, width:b.width, height:b.height,
                border:`2px solid ${sel.color}`, borderRadius:4, pointerEvents:'none', zIndex:1500
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
  )
}
