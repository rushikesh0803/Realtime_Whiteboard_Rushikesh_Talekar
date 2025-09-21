// src/hooks/usePresence.js
import { useEffect, useMemo, useRef, useState } from 'react'

/**
 * usePresence(socket, editor, me, { boardId, getBounds })
 * Returns: { users, selections, cursors, cursorsRef }
 */
export default function usePresence(socket, editor, me, opts = {}) {
  const boardId = opts.boardId
  const getBounds = opts.getBounds || (() => ({ left: 0, top: 0 }))

  const [usersArr, setUsersArr] = useState([])
  const [selections, setSelections] = useState({})
  const cursorsRef = useRef({})
  const usersMapRef = useRef(new Map()) // key by socketId to match presence:leave

  const pushUser = (u) => {
    if (!u) return
    const key = u.socketId || u.id || u.userId || u._id
    if (!key) return
    usersMapRef.current.set(key, {
      id: u.id || u.userId || u._id || key, // stable "user id" for avatar seed
      name: u.name || 'User',
      color: u.color || '#7c3aed',
      socketId: key,
      boardId: u.boardId,
    })
    setUsersArr(Array.from(usersMapRef.current.values()))
  }
  const dropUser = (socketId) => {
    if (!socketId) return
    usersMapRef.current.delete(socketId)
    setUsersArr(Array.from(usersMapRef.current.values()))
  }

  // Announce myself AFTER connection; also add myself locally (in case server broadcast is filtered)
  useEffect(() => {
    if (!socket || !boardId || !me?.id) return
    const announce = () => {
      // add myself locally immediately
      pushUser({ id: me.id, name: me.name, color: me.color, socketId: socket.id, boardId })
      // tell server
      socket.emit('presence:join', { id: me.id, name: me.name || 'User', color: me.color || '#7c3aed', boardId })
    }
    socket.on('connect', announce)
    return () => socket.off('connect', announce)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [socket, boardId, me.id, me.name, me.color])

  // Presence + initial roster + cursors + selections
  useEffect(() => {
    if (!socket || !boardId) return

    const onRoster = (list = []) => {
      usersMapRef.current.clear()
      list.forEach(pushUser)
    }
    const onJoin = (u = {}) => { if (!u.boardId || u.boardId === boardId) pushUser(u) }
    const onLeave = (socketId) => {
      dropUser(socketId)
      delete cursorsRef.current[socketId]
      setSelections((s) => {
        const n = { ...s }
        delete n[socketId]
        return n
      })
    }
    const onMove = (p = {}) => {
      if (p.boardId && p.boardId !== boardId) return
      const key = p.socketId || p.id
      if (!key) return
      cursorsRef.current[key] = {
        id: p.id || key, x: p.x, y: p.y, name: p.name, color: p.color, active: p.active ?? true,
      }
    }
    const onActive = (p = {}) => onMove({ ...p, active: true })
    const onLeaveCursor = (id) => { delete cursorsRef.current[id] }
    const onSel = (sel = {}) => {
      if (sel.boardId && sel.boardId !== boardId) return
      const key = sel.socketId || sel.userId || sel.id
      setSelections((s) => ({ ...s, [key]: sel }))
    }

    socket.on('presence:roster', onRoster)
    socket.on('presence:join', onJoin)
    socket.on('presence:leave', onLeave)
    socket.on('cursor:move', onMove)
    socket.on('cursor:active', onActive)
    socket.on('cursor:leave', onLeaveCursor)
    socket.on('selection:update', onSel)

    // Ask roster explicitly if we connect late
    const reqRoster = () => socket.emit('presence:list', { boardId }, (res) => {
      if (res?.ok && Array.isArray(res.users)) onRoster(res.users)
    })
    reqRoster()
    socket.on('connect', reqRoster)

    return () => {
      socket.off('presence:roster', onRoster)
      socket.off('presence:join', onJoin)
      socket.off('presence:leave', onLeave)
      socket.off('cursor:move', onMove)
      socket.off('cursor:active', onActive)
      socket.off('cursor:leave', onLeaveCursor)
      socket.off('selection:update', onSel)
      socket.off('connect', reqRoster)
    }
  }, [socket, boardId])

  // Send my cursor positions
  useEffect(() => {
    if (!socket || !editor || !boardId || !me?.id) return

    let raf = null
    let last = { x: 0, y: 0 }

    const send = (x, y, active = false) => {
      socket.emit(active ? 'cursor:active' : 'cursor:move', {
        id: me.id, name: me.name || 'Me', color: me.color || '#7c3aed', x, y, boardId
      })
    }

    const onPointerMove = (e) => {
      const b = getBounds() || { left: 0, top: 0 }
      const x = e.clientX - b.left
      const y = e.clientY - b.top
      if (Math.abs(x - last.x) + Math.abs(y - last.y) < 2) return
      last = { x, y }
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => send(x, y, false))
    }
    const onPointerDown = (e) => {
      const b = getBounds() || { left: 0, top: 0 }
      send(e.clientX - b.left, e.clientY - b.top, true)
    }
    const onLeave = () => socket.emit('cursor:leave', socket.id)

    window.addEventListener('pointermove', onPointerMove, { passive: true })
    window.addEventListener('pointerdown', onPointerDown, { passive: true })
    window.addEventListener('blur', onLeave)

    return () => {
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('blur', onLeave)
      cancelAnimationFrame(raf)
      onLeave()
    }
  }, [socket, editor, boardId, me.id, me.name, me.color, getBounds])

  const users = useMemo(() => usersArr, [usersArr])
  return { users, selections, cursors: cursorsRef.current, cursorsRef }
}
