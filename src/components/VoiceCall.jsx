// src/components/VoiceCall.jsx
import React, { useEffect, useRef, useState } from 'react'

const ICE = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] }
const getId = (p) => p?.userId ?? p?.from

export default function VoiceCall({ socket, me, boardId, onEnd }) {
  const [phase, setPhase] = useState('prejoin')
  const [minimized, setMinimized] = useState(false)
  const [elapsed, setElapsed] = useState(0)

  const [devices, setDevices] = useState({ mics: [] })
  const [micId, setMicId] = useState('')
  const [level, setLevel] = useState(0)
  const [levels, setLevels] = useState({})
  const [userMap, setUserMap] = useState({})

  const localStreamRef = useRef(null)
  const audioCtxRef = useRef(null)
  const analyserRef = useRef(null)
  const rafRef = useRef(null)

  const peersRef = useRef(new Map()) // userId -> { pc, audio, stream }
  const participantsRef = useRef(new Set([me.id]))
  const startedAtRef = useRef(Date.now())

  const speakingNow = (id) => (id === me.id ? level : (levels[id] || 0)) > 0.22
  const participants = () => Array.from(participantsRef.current)

  const closePeer = (peerId) => {
    const peer = peersRef.current.get(peerId)
    if (!peer) return
    try { peer.pc.ontrack = null; peer.pc.onicecandidate = null } catch {}
    try { peer.pc.getSenders?.().forEach(s => s.track && s.track.stop?.()) } catch {}
    try { peer.pc.close() } catch {}
    try { peer.audio && (peer.audio.srcObject = null) } catch {}
    peersRef.current.delete(peerId)
    participantsRef.current.delete(peerId)
  }

  const ensureMic = async () => {
    if (localStreamRef.current) { localStreamRef.current.getTracks().forEach(t => t.stop()); localStreamRef.current = null }
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { deviceId: micId ? { exact: micId } : undefined, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: false,
    })
    localStreamRef.current = stream

    const ctx = audioCtxRef.current || new (window.AudioContext || window.webkitAudioContext)()
    audioCtxRef.current = ctx
    try { if (ctx.state === 'suspended') await ctx.resume() } catch {}
    const analyser = ctx.createAnalyser()
    analyser.fftSize = 256
    ctx.createMediaStreamSource(stream).connect(analyser)
    analyserRef.current = analyser

    const tick = () => {
      const arr = new Uint8Array(analyser.frequencyBinCount)
      analyser.getByteTimeDomainData(arr)
      let max = 0
      for (let i = 0; i < arr.length; i++) max = Math.max(max, Math.abs(arr[i] - 128))
      const v = Math.min(1, max / 80)
      setLevel(v)
      socket?.emit('call:level', { boardId, from: me.id, level: v })
      rafRef.current = requestAnimationFrame(tick)
    }
    tick()
  }

  const getOrCreatePeer = (peerId) => {
    let peer = peersRef.current.get(peerId)
    if (peer) return peer
    const pc = new RTCPeerConnection(ICE)
    if (localStreamRef.current) for (const t of localStreamRef.current.getTracks()) pc.addTrack(t, localStreamRef.current)
    const remoteStream = new MediaStream()
    const audio = document.createElement('audio')
    audio.autoplay = true
    audio.playsInline = true
    audio.srcObject = remoteStream
    pc.ontrack = (ev) => { ev.streams[0]?.getTracks().forEach(t => remoteStream.addTrack(t)) }
    pc.onicecandidate = (ev) => { if (ev.candidate) socket?.emit('call:ice', { boardId, from: me.id, to: peerId, candidate: ev.candidate }) }
    peer = { pc, audio, stream: remoteStream }
    peersRef.current.set(peerId, peer)
    participantsRef.current.add(peerId)
    return peer
  }

  const makeOffer = async (to) => {
    const { pc } = getOrCreatePeer(to)
    try {
      const offer = await pc.createOffer()
      await pc.setLocalDescription(offer)
      socket?.emit('call:offer', { boardId, from: me.id, to, sdp: offer })
    } catch (e) { console.warn('[offer] failed', e) }
  }

  const bindPushToTalk = () => {
    const setMuted = (muted) => { const t = localStreamRef.current?.getAudioTracks?.()[0]; if (t) t.enabled = !muted }
    const onKeyDown = (e) => {
      const el = e.target
      const typing = el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)
      if (typing) return
      if (e.code === 'Space' && !e.repeat) setMuted(false)
    }
    const onKeyUp = (e) => { if (e.code === 'Space') { const t = localStreamRef.current?.getAudioTracks?.()[0]; if (t) t.enabled = false } }
    window.addEventListener('keydown', onKeyDown); window.addEventListener('keyup', onKeyUp)
    return () => { window.removeEventListener('keydown', onKeyDown); window.removeEventListener('keyup', onKeyUp) }
  }

  // names from members API (note: use userId)
  useEffect(() => {
    (async () => {
      try {
        const r = await fetch(`/api/boards/${boardId}/members`, { credentials: 'include' })
        if (r.ok) {
          const rows = await r.json()
          const m = {}
          rows.forEach(u => { m[u.userId] = u.name || u.email || u.userId })
          m[me.id] = me.name || me.email || me.id
          setUserMap(m)
        } else {
          setUserMap({ [me.id]: me.name || me.email || me.id })
        }
      } catch {
        setUserMap({ [me.id]: me.name || me.email || me.id })
      }
    })()
  }, [boardId, me.id, me.name, me.email])

  useEffect(() => {
    navigator.mediaDevices.enumerateDevices()
      .then(list => setDevices({ mics: list.filter(d => d.kind === 'audioinput') }))
      .catch(() => {})
  }, [])

  useEffect(() => {
    if (phase !== 'prejoin') return
    ;(async () => { try { await ensureMic() } catch { alert('Microphone blocked or unavailable') } })()
    return () => cancelAnimationFrame(rafRef.current)
  }, [phase, micId])

  useEffect(() => {
    const resume = async () => { try { if (audioCtxRef.current && audioCtxRef.current.state === 'suspended') await audioCtxRef.current.resume() } catch {} }
    window.addEventListener('pointerdown', resume, { once: true, capture: true })
    return () => window.removeEventListener('pointerdown', resume, { capture: true })
  }, [])

  useEffect(() => {
    if (!socket) return

    const onHello = async (p) => {
      if (phase !== 'incall') return
      if ((p.boardId && p.boardId !== boardId)) return
      const otherId = getId(p)
      if (!otherId || otherId === me.id) return
      await ensureMic()
      const iStart = String(me.id) < String(otherId)
      getOrCreatePeer(otherId)
      if (iStart) await makeOffer(otherId)
      participantsRef.current.add(otherId)
      if (p?.name) setUserMap(m => ({ ...m, [otherId]: p.name }))
    }

    const onOffer = async ({ from, to, sdp, boardId: b }) => {
      if (phase !== 'incall' || to !== me.id) return
      if (b && b !== boardId) return
      await ensureMic()
      const { pc } = getOrCreatePeer(from)
      try {
        await pc.setRemoteDescription(new RTCSessionDescription(sdp))
        const answer = await pc.createAnswer()
        await pc.setLocalDescription(answer)
        socket.emit('call:answer', { boardId, from: me.id, to: from, sdp: answer })
      } catch (e) { console.warn('[answer] failed', e) }
    }

    const onAnswer = async ({ from, to, sdp, boardId: b }) => {
      if (to !== me.id) return
      if (b && b !== boardId) return
      const peer = peersRef.current.get(from)
      if (!peer) return
      try { await peer.pc.setRemoteDescription(new RTCSessionDescription(sdp)) } catch (e) { console.warn('[setRemote answer] failed', e) }
    }

    const onIce = async ({ from, to, candidate, boardId: b }) => {
      if (to !== me.id) return
      if (b && b !== boardId) return
      const peer = peersRef.current.get(from)
      if (!peer || !candidate) return
      try { await peer.pc.addIceCandidate(new RTCIceCandidate(candidate)) } catch (e) { console.warn('[ice] failed', e) }
    }

    const onLeave = (p) => { if (p.boardId && p.boardId !== boardId) return; const id = getId(p); if (id) closePeer(id) }
    const onLevel = ({ from, level, boardId: b }) => { if (b && b !== boardId) return; setLevels(lv => ({ ...lv, [from]: level })) }

    socket.on('call:hello', onHello)
    socket.on('call:offer', onOffer)
    socket.on('call:answer', onAnswer)
    socket.on('call:ice', onIce)
    socket.on('call:leave', onLeave)
    socket.on('call:level', onLevel)

    const re = () => { if (phase === 'incall') socket.emit('call:hello', { boardId, userId: me.id, name: me.name }) }
    socket.on('connect', re)

    return () => {
      socket.off('call:hello', onHello)
      socket.off('call:offer', onOffer)
      socket.off('call:answer', onAnswer)
      socket.off('call:ice', onIce)
      socket.off('call:leave', onLeave)
      socket.off('call:level', onLevel)
      socket.off('connect', re)
    }
  }, [socket, phase, me.id, me.name, boardId])

  async function startCall() {
    try {
      await ensureMic()
      setPhase('incall')
      startedAtRef.current = Date.now()
      const t = setInterval(() => setElapsed(Math.floor((Date.now() - startedAtRef.current) / 1000)), 1000)
      startCall._t = t
      const track = localStreamRef.current?.getAudioTracks?.()[0]; if (track) track.enabled = false
      startCall._unbindPTT = bindPushToTalk()
      socket.emit('call:hello', { boardId, userId: me.id, name: me.name || me.email })
      setMinimized(false); window.__vcMinimized = false; window.dispatchEvent(new Event('vc-minimize-changed'))
    } catch { alert('Could not start call.') }
  }

  function leaveCall() {
    for (const id of Array.from(peersRef.current.keys())) closePeer(id)
    localStreamRef.current?.getTracks()?.forEach(t => t.stop())
    localStreamRef.current = null
    cancelAnimationFrame(rafRef.current)
    if (startCall._t) clearInterval(startCall._t)
    startCall._unbindPTT?.()
    socket?.emit('call:leave', { boardId, userId: me.id })
    window.__vcMinimized = false
    window.dispatchEvent(new Event('vc-minimize-changed'))
    onEnd?.()
  }

  function toggleMute() { const t = localStreamRef.current?.getAudioTracks?.()[0]; if (t) t.enabled = !t.enabled }
  function setMini(v) { setMinimized(v); window.__vcMinimized = !!v; window.dispatchEvent(new Event('vc-minimize-changed')) }

  const people = participants().map(id => ({ id, name: userMap[id] || id, speaking: speakingNow(id) }))
  const timeTxt = `${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, '0')}`

  if (phase === 'incall' && minimized) {
    return (
      <div className="fixed top-4 left-1/2 -translate-x-1/2 z-50">
        <div className="bg-white/95 dark:bg-zinc-900/95 border rounded-full shadow-lg pl-3 pr-2 py-2 flex items-center gap-3">
          <span className="text-sm">🔊 {people.length} · {timeTxt}</span>
          <button className="px-2 py-1 text-xs rounded bg-emerald-600 text-white" onClick={toggleMute}>Mute</button>
          <button className="px-2 py-1 text-xs rounded bg-rose-600 text-white" onClick={leaveCall}>Leave</button>
          <button className="px-2 py-1 text-xs rounded border" onClick={() => setMini(false)}>Expand</button>
        </div>
      </div>
    )
  }

  if (phase === 'prejoin') {
    return (
      <div id="voice-panel" className="fixed right-4 bottom-40 z-50 w-[380px] max-w-[95vw] bg-white/95 dark:bg-zinc-900/95 backdrop-blur border rounded-xl shadow-lg p-4">
        <h2 className="text-lg font-semibold mb-3">🎙️ Voice Setup</h2>
        <label className="block text-sm opacity-70 mb-1">Microphone</label>
        <select className="input w-full mb-3" value={micId} onChange={e => setMicId(e.target.value)}>
          <option value="">Default microphone</option>
          {devices.mics.map(d => <option key={d.deviceId} value={d.deviceId}>{d.label || d.deviceId}</option>)}
        </select>
        <div className="h-3 bg-zinc-200 dark:bg-zinc-800 rounded overflow-hidden mb-4">
          <div className="h-3 transition-all" style={{ width: `${Math.floor(level * 100)}%`, background: 'var(--tw-color-emerald-500, #10b981)' }} />
        </div>
        <div className="text-xs opacity-70 mb-3">Tip: Hold <kbd>Space</kbd> to speak (push-to-talk) once you join.</div>
        <div className="flex gap-2">
          <button className="btn flex-1" onClick={startCall}>✅ Join Voice</button>
          <button className="btn-outline flex-1" onClick={onEnd}>✕ Cancel</button>
        </div>
      </div>
    )
  }

  return (
    <div id="voice-panel" className="fixed right-4 bottom-40 z-50 w-[460px] max-w-[95vw] bg-white/95 dark:bg-zinc-900/95 border rounded-xl shadow-lg">
      <div className="px-3 py-2 border-b flex items-center justify-between">
        <div>
          <div className="font-semibold">Voice call</div>
          <div className="text-xs opacity-70">{people.length} participants · {timeTxt}</div>
        </div>
        <div className="flex items-center gap-2">
          <button className="text-xs px-2 py-1 rounded border" onClick={() => {
            try { const url = new URL(window.location.href); url.searchParams.set('id', boardId); navigator.clipboard?.writeText(url.toString()) } catch {}
          }}>Copy invite link</button>
          <button className="text-xs px-2 py-1 rounded border" onClick={() => setMini(true)}>Minimize</button>
          <button className="text-xs px-2 py-1 rounded border" onClick={leaveCall}>Leave</button>
        </div>
      </div>

      <div className="p-4 space-y-4">
        <div className="flex flex-wrap gap-4">
          {people.map(p => (
            <div key={p.id} className="flex flex-col items-center text-xs">
              <div className={`w-12 h-12 rounded-full grid place-items-center border-2 ${p.speaking ? 'border-emerald-500 shadow-[0_0_12px_#10b981] animate-pulse' : 'border-zinc-300 dark:border-zinc-700'}`} title={p.name}>
                {(p.name || '?').slice(0, 1).toUpperCase()}
              </div>
              <div className="mt-1 max-w-[9rem] truncate text-center" title={p.name}>
                {p.name}{p.id === me.id ? ' (You)' : ''}
              </div>
            </div>
          ))}
        </div>

        <div>
          <div className="text-xs opacity-70 mb-1">Your mic (hold <kbd>Space</kbd> to talk)</div>
          <div className="h-2 bg-zinc-200 dark:bg-zinc-800 rounded overflow-hidden">
            <div className="h-2 transition-all" style={{ width: `${Math.floor(level * 100)}%`, background: 'var(--tw-color-emerald-500, #10b981)' }} />
          </div>
          <div className="mt-3 flex gap-2">
            <button className="px-3 py-2 rounded bg-emerald-600 text-white" onClick={toggleMute}>Toggle Mute</button>
            <button className="px-3 py-2 rounded bg-rose-600 text-white" onClick={leaveCall}>Leave Call</button>
          </div>
        </div>
      </div>
    </div>
  )
}
