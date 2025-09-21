// src/lib/api.js  (final)
// ----------------------------------------------------
import { io } from 'socket.io-client'

// WebSocket base (can be cross-origin)
export const SERVER_URL =
  (import.meta.env?.VITE_SERVER_WS_URL && String(import.meta.env.VITE_SERVER_WS_URL)) ||
  (import.meta.env?.VITE_SERVER_URL && String(import.meta.env.VITE_SERVER_URL)) ||
  'http://localhost:4000'

// Keep REST same-origin so Vite proxy forwards cookies
function restUrl(path = '') {
  const p = String(path || '')
  if (/^https?:\/\//i.test(p)) return p
  if (p.startsWith('/api') || p.startsWith('/uploads')) return p
  return p.startsWith('/') ? p : `/${p}`
}

function ensureJsonResponse(res) {
  const ct = (res.headers.get('content-type') || '').toLowerCase()
  return ct.includes('application/json')
}

async function parseJsonOrThrow(res) {
  if (!ensureJsonResponse(res)) {
    const text = await res.text().catch(() => '')
    const head = (text || '').slice(0, 200).replace(/\s+/g, ' ')
    throw new Error(`Expected JSON but got "${res.headers.get('content-type') || 'unknown'}" from ${res.url}. Body: ${head}`)
  }
  return res.json()
}

/** Fetch helper for REST (same-origin -> cookies work via Vite proxy) */
export function apiFetch(path, options = {}) {
  const url = restUrl(path)
  return fetch(url, {
    credentials: 'include',
    headers: { Accept: 'application/json', ...(options.headers || {}) },
    ...options,
  })
}

export async function getJson(path) {
  const res = await apiFetch(path)
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`GET ${path} failed: ${res.status} ${text}`)
  }
  return parseJsonOrThrow(res)
}

export async function postJson(path, body) {
  const res = await apiFetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body ?? {}),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`POST ${path} failed: ${res.status} ${text}`)
  }
  return parseJsonOrThrow(res)
}

/** Real-time board socket + presence handshake (robust reconnect) */
export function connectBoardSocket(boardId, user, opts = {}) {
  if (!boardId) throw new Error('boardId required')
  const s = io(`${SERVER_URL}/room:board:${boardId}`, {
    withCredentials: true,
    transports: ['websocket'],
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 500,
    reconnectionDelayMax: 5000,
    randomizationFactor: 0.5,
    timeout: 15000,
    ...opts,
  })
  s.on('connect', () => { if (user) s.emit('presence:join', user) })
  return s
}

/** Get existing ?id= or create a new board and update the URL */
export async function getOrCreateBoard() {
  const params = new URLSearchParams(window.location.search)
  let id = params.get('id')
  if (!id) {
    const saved = localStorage.getItem('last_board_id')
    if (saved) id = saved
  }
  if (!id) {
    const b = await postJson('/api/boards', { title: 'Untitled' })
    id = b._id || b.id
  }
  localStorage.setItem('last_board_id', id)
  const url = new URL(window.location.href)
  if (url.searchParams.get('id') !== id) {
    url.searchParams.set('id', id)
    window.history.replaceState({}, '', url.toString())
  }
  return id
}

export function apiUrl(path = '') {
  return restUrl(path)
}
