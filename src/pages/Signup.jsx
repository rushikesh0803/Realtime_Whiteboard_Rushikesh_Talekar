// src/pages/Signup.jsx
import React, { useState } from 'react'

const SERVER_URL = import.meta.env.VITE_SERVER_URL || 'http://localhost:4000'
const API_BASE   = SERVER_URL

export default function Signup() {
  const [form, setForm] = useState({ name: '', email: '', username: '', password: '' })
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState('')

  async function onSubmit(e) {
    e.preventDefault()
    setErr('')
    setLoading(true)

    const ctl = new AbortController()
    const t = setTimeout(() => ctl.abort(), 12000)

    try {
      const payload = {
        name: form.name.trim(),
        email: form.email.trim().toLowerCase(),
        ...(form.username.trim() ? { username: form.username.trim() } : {}),
        password: form.password,
      }

      const res = await fetch(`${API_BASE}/api/auth/signup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(payload),
        signal: ctl.signal,
      })

      const contentType = res.headers.get('content-type') || ''
      const body = contentType.includes('application/json')
        ? await res.json().catch(() => ({}))
        : await res.text().catch(() => '')

      if (!res.ok) {
        const msg = (typeof body === 'object' && (body.error || body.message))
          || (typeof body === 'string' && body)
          || `Signup failed (HTTP ${res.status})`
        setErr(msg)
        return
      }

      // Cookie is set by server; go home (App will fetch /api/me)
      window.location.href = '/'
    } catch (e) {
      if (e.name === 'AbortError') setErr('Request timed out. Server not responding.')
      else setErr('Network/CORS error. Check server URL & CORS.')
      console.error('Signup error:', e)
    } finally {
      clearTimeout(t)
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-6">
      <form onSubmit={onSubmit} className="w-full max-w-sm space-y-4 bg-white/70 dark:bg-zinc-900/70 p-6 rounded-xl shadow">
        <h1 className="text-xl font-bold text-center">Create account</h1>

        <input
          className="input w-full"
          placeholder="Full name"
          value={form.name}
          onChange={(e)=>setForm({...form, name: e.target.value})}
          required
          autoComplete="name"
        />

        <input
          className="input w-full"
          placeholder="Email ID"
          type="email"
          value={form.email}
          onChange={(e)=>setForm({...form, email: e.target.value})}
          required
          autoComplete="email"
        />

        <input
          className="input w-full"
          placeholder="Username (optional)"
          value={form.username}
          onChange={(e)=>setForm({...form, username: e.target.value})}
          autoComplete="username"
        />

        <input
          className="input w-full"
          placeholder="Password"
          type="password"
          value={form.password}
          onChange={(e)=>setForm({...form, password: e.target.value})}
          required
          autoComplete="new-password"
        />

        {err && <p className="text-sm text-red-600 text-center">{err}</p>}

        <button className="btn w-full" disabled={loading}>
          {loading ? 'Creating…' : 'Sign up'}
        </button>

        <p className="text-sm text-center">
          Already have an account?{' '}
          <a href="/signin" className="text-indigo-600 hover:underline">Sign in</a>
        </p>
      </form>
    </div>
  )
}
