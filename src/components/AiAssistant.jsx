// src/components/AiAssistant.jsx
import { useEffect, useRef, useState } from 'react'
import { aiChat } from '../lib/ai'

export default function AiAssistant({ open, onClose, me }) {
  const [busy, setBusy] = useState(false)
  const [input, setInput] = useState('')
  const [thread, setThread] = useState([
    { role: 'system', content: 'You are an assistant helping with whiteboard tasks.' }
  ])
  const boxRef = useRef(null)

  useEffect(() => {
    if (open) setTimeout(() => boxRef.current?.focus(), 50)
  }, [open])

  async function send(e) {
    e?.preventDefault?.()
    const text = input.trim()
    if (!text || busy) return
    setInput('')
    const next = [...thread, { role: 'user', content: text }]
    setThread(next)
    setBusy(true)
    try {
      const { text: answer } = await aiChat(next)
      setThread([...next, { role: 'assistant', content: answer || '(no answer)' }])
    } catch (err) {
      setThread([...next, { role: 'assistant', content: `⚠️ ${err.message}` }])
    } finally {
      setBusy(false)
    }
  }

  if (!open) return null

  return (
    <div style={{
      position:'fixed', right:16, bottom:16, width:360, maxHeight:'70vh',
      background:'rgba(255,255,255,0.98)', color:'#0f172a', border:'1px solid rgba(0,0,0,0.12)',
      borderRadius:12, boxShadow:'0 12px 40px rgba(0,0,0,0.2)', display:'flex', flexDirection:'column', zIndex:5000
    }}>
      <div style={{ padding:'10px 12px', borderBottom:'1px solid rgba(0,0,0,0.1)', display:'flex', alignItems:'center' }}>
        <strong style={{ flex:1 }}>AI Assistant</strong>
        <button onClick={onClose} style={{ border:'none', background:'transparent', cursor:'pointer', fontSize:18 }}>×</button>
      </div>

      <div style={{ padding:12, overflow:'auto' }}>
        {thread.filter(m=>m.role!=='system').map((m, i) => (
          <div key={i} style={{ margin:'8px 0' }}>
            <div style={{ fontSize:11, opacity:0.6, marginBottom:2 }}>{m.role === 'user' ? (me?.name || 'You') : 'Assistant'}</div>
            <div style={{
              whiteSpace:'pre-wrap', background:m.role==='user'?'#eef2ff':'#f8fafc',
              border:'1px solid rgba(0,0,0,0.06)', padding:8, borderRadius:8, fontSize:14
            }}>{m.content}</div>
          </div>
        ))}
        {busy && <div style={{ fontSize:12, opacity:0.7, marginTop:6 }}>thinking…</div>}
      </div>

      <form onSubmit={send} style={{ padding:12, borderTop:'1px solid rgba(0,0,0,0.1)', display:'flex', gap:8 }}>
        <input
          ref={boxRef}
          value={input}
          onChange={(e)=>setInput(e.target.value)}
          placeholder="Ask anything…"
          style={{ flex:1, padding:'10px 12px', borderRadius:8, border:'1px solid rgba(0,0,0,0.12)', outline:'none' }}
        />
        <button className="btn" disabled={busy} style={{ padding:'0 12px' }}>Send</button>
      </form>
    </div>
  )
}
