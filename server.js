// server.js  (presence roster + deep sanitize + lag-friendly)
import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import cookieParser from 'cookie-parser'
import { createServer } from 'http'
import { Server } from 'socket.io'
import mongoose from 'mongoose'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import path from 'path'
import fs from 'fs'
import crypto from 'crypto'

/* ========================== ENV ========================== */
const NODE_ENV   = process.env.NODE_ENV || 'development'
const PORT       = Number(process.env.PORT || 4000)
const CLIENT_URL = process.env.CLIENT_URL || 'http://localhost:5173'
const MONGO_URL  = process.env.MONGO_URL  || 'mongodb://127.0.0.1:27017/whiteboarddb'
const JWT_SECRET = process.env.JWT_SECRET || 'dev_super_secret_change_me'

const ALLOWED_ORIGINS = new Set(
  (process.env.CORS_ORIGINS?.split(',') || [])
    .map(s => s.trim())
    .filter(Boolean)
    .concat([
      CLIENT_URL,
      'http://localhost:5173','http://127.0.0.1:5173',
      'http://localhost:5174','http://127.0.0.1:5174',
      'http://localhost:5175','http://127.0.0.1:5175',
    ])
)

/* ========================== APP ========================== */
const app = express()
app.set('trust proxy', 1)
const httpServer = createServer(app)
const io = new Server(httpServer, {
  cors: {
    origin: (origin, cb) =>
      (!origin || ALLOWED_ORIGINS.has(origin)) ? cb(null, true) : cb(new Error(`CORS blocked: ${origin}`)),
    credentials: true,
  },
})

/* ====================== MIDDLEWARE ======================= */
const allowOrigin = (origin, cb) =>
  (!origin || ALLOWED_ORIGINS.has(origin)) ? cb(null, true) : cb(new Error(`CORS blocked: ${origin}`))

app.use(cors({ origin: allowOrigin, credentials: true }))
app.use(express.json({ limit: '5mb' }))
app.use(cookieParser())
app.options('*', cors({ origin: allowOrigin, credentials: true }))

// Always JSON under /api
app.use('/api', (_req, res, next) => { res.type('application/json'); next() })
app.use((req, _res, next) => { console.log(`[req] ${req.method} ${req.path}`); next() })

// static uploads
const uploadsDir = path.resolve('uploads')
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir)
app.use('/uploads', express.static(uploadsDir))

/* ======================== MODELS ========================= */
const userSchema = new mongoose.Schema({
  email: { type: String, unique: true, required: true, lowercase: true, trim: true },
  username: { type: String, unique: true, sparse: true, trim: true },
  name: { type: String, trim: true },
  passwordHash: { type: String, required: true },
  color: { type: String, default: () => '#' + Math.floor(Math.random()*16777215).toString(16).padStart(6,'0') },
}, { timestamps: true })
userSchema.index({ email: 1 })
userSchema.index({ username: 1 }, { unique: true, sparse: true })

const boardSchema = new mongoose.Schema({
  title: String,
  document: { type: Object, default: { tldraw: null, ops: [], updatedAt: Date.now() } },
  members: [{
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    role: { type: String, enum: ['owner', 'editor', 'viewer'], default: 'owner' },
  }],
  chat: [{
    id: String,
    userId: String,
    name: String,
    text: String,
    replyTo: String,
    reactions: Object,
    linkPreview: Object,
    ts: Number,
  }],
  publicViewerToken: { type: String, default: '' },
}, { timestamps: true })

const User = mongoose.model('User', userSchema)
const Board = mongoose.model('Board', boardSchema)

/* ============== RECOVERY / HISTORY MODELS ================ */
const counterSchema = new mongoose.Schema({ _id: String, seq: { type: Number, default: 0 } })
const Counter = mongoose.model('Counter', counterSchema)

const boardOpSchema = new mongoose.Schema({
  boardId: { type: mongoose.Schema.Types.ObjectId, index: true, required: true },
  seq: { type: Number, index: true },
  opId: { type: String, index: true },
  op: { type: Object, required: true },
  authorId: { type: mongoose.Schema.Types.ObjectId, index: true },
  ts: { type: Date, default: Date.now, index: true },
}, { timestamps: true })
boardOpSchema.index({ boardId: 1, opId: 1 }, { unique: true, sparse: true })
const BoardOp = mongoose.model('BoardOp', boardOpSchema)

const boardSnapshotSchema = new mongoose.Schema({
  boardId: { type: mongoose.Schema.Types.ObjectId, index: true, required: true },
  version: { type: Number, index: true },
  tldraw: { type: Object, default: null },
  checksum: { type: String, default: '' },
  createdAt: { type: Date, default: Date.now, index: true },
}, { timestamps: true })
boardSnapshotSchema.index({ boardId: 1, version: -1 })
const BoardSnapshot = mongoose.model('BoardSnapshot', boardSnapshotSchema)

/* ======================= HELPERS ========================= */
async function nextBoardSeq(boardId, session) {
  const key = `board:${boardId.toString()}:op_seq`
  const doc = await Counter.findOneAndUpdate(
    { _id: key },
    { $inc: { seq: 1 } },
    { new: true, upsert: true, session }
  )
  return doc.seq
}
const hashObj = (obj) => crypto.createHash('sha256').update(JSON.stringify(obj || {})).digest('hex')

/* -------- TLDraw deep sanitize (server-side) -------- */
function ensureAnyMeta(rec) {
  if (!rec || typeof rec !== 'object') return
  if ('meta' in rec && (rec.meta === undefined || rec.meta === null)) rec.meta = {}
  const v = rec.value
  if (v && typeof v === 'object' && 'meta' in v && (v.meta === undefined || v.meta === null)) v.meta = {}
}
function ensureDocMetaOnRecord(rec) {
  if (!rec) return
  const isDoc =
    rec.typeName === 'tl_document' ||
    rec.type === 'document' ||
    (typeof rec.typeName === 'string' && rec.typeName.endsWith('_document')) ||
    (typeof rec.id === 'string' && rec.id.startsWith('document:'))
  if (isDoc) {
    if (rec.meta == null) rec.meta = {}
    if (rec.value && typeof rec.value === 'object' && rec.value.meta == null) rec.value.meta = {}
  }
  ensureAnyMeta(rec)
}
function sanitizeTlSnapshotDeep(snap) {
  if (!snap || typeof snap !== 'object') return null
  const c = JSON.parse(JSON.stringify(snap))
  const r1 = c?.store?.records
  const r2 = c?.records
  let recs = []
  if (Array.isArray(r1)) recs = r1
  else if (r1 && typeof r1 === 'object') recs = Object.values(r1)
  else if (Array.isArray(r2)) recs = r2
  else if (r2 && typeof r2 === 'object') recs = Object.values(r2)
  recs.forEach(ensureDocMetaOnRecord)
  if (c.document && c.document.meta == null) c.document.meta = {}
  return c
}

/* ==================== AUTH HELPERS ====================== */
const signAccess = (payload) => jwt.sign(payload, JWT_SECRET, { expiresIn: '7d' })

function setAuthCookie(res, token) {
  const isProd = NODE_ENV === 'production'
  res.cookie('access_token', token, {
    httpOnly: true,
    path: '/',
    maxAge: 7 * 24 * 60 * 60 * 1000,
    sameSite: isProd ? 'none' : 'lax',
    secure: isProd,
  })
}
function clearAuthCookie(res) {
  const isProd = NODE_ENV === 'production'
  res.cookie('access_token', '', { httpOnly: true, path: '/', maxAge: 0, sameSite: isProd ? 'none' : 'lax', secure: isProd })
}
function requireAuth(req, res, next) {
  const t = req.cookies?.access_token
  if (!t) return res.status(401).json({ error: 'Unauthenticated' })
  try { req.user = jwt.verify(t, JWT_SECRET); next() } catch { return res.status(401).json({ error: 'Invalid token' }) }
}

/* ====================== ROUTES ========================== */
app.get('/api/health', (_req, res) => {
  res.json({ ok: true, env: NODE_ENV, db: mongoose.connection.readyState, clientUrl: CLIENT_URL, mongo: MONGO_URL })
})

/* ---- Auth ---- */
app.post('/api/auth/signup', async (req, res) => {
  try {
    const email = String(req.body?.email || '').trim().toLowerCase()
    const password = String(req.body?.password || '')
    const rawName = String(req.body?.name || '').trim()
    const username = (String(req.body?.username || '').trim()) || undefined
    if (!email || !password) return res.status(400).json({ error: 'Missing email/password' })
    if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 chars' })

    const existsByEmail = await User.findOne({ email }).lean()
    if (existsByEmail) return res.status(409).json({ error: 'Email in use' })
    if (username) {
      const existsByUsername = await User.findOne({ username }).lean()
      if (existsByUsername) return res.status(409).json({ error: 'Username in use' })
    }

    const passwordHash = await bcrypt.hash(password, 12)
    const name = rawName || email.split('@')[0]
    const u = await User.create({ email, username, name, passwordHash })

    const token = signAccess({ sub: u._id.toString(), email: u.email, name: u.name, username: u.username || null, color: u.color })
    setAuthCookie(res, token)
    res.status(201).json({ user: { id: u._id, email: u.email, name: u.name, username: u.username || null, color: u.color } })
  } catch (err) {
    if (err?.code === 11000) {
      const key = Object.keys(err?.keyPattern || {})[0] || 'email'
      return res.status(409).json({ error: `${key[0].toUpperCase()+key.slice(1)} in use` })
    }
    console.error('[signup] error', err)
    res.status(500).json({ error: 'Server error' })
  }
})

app.post('/api/auth/signin', async (req, res) => {
  try {
    const id = String(req.body?.identifier || '').trim()
    const emailF = String(req.body?.email || '').trim()
    const usernameF = String(req.body?.username || '').trim()
    const password = String(req.body?.password || '')
    if (!password) return res.status(400).json({ error: 'Password required' })

    let query = null
    if (id) query = id.includes('@') ? { email: id.toLowerCase() } : { $or: [{ username: id }, { email: id.toLowerCase() }] }
    else if (emailF || usernameF) query = emailF ? { email: emailF.toLowerCase() } : { username: usernameF }
    else return res.status(400).json({ error: 'Identifier required' })

    const u = await User.findOne(query)
    if (!u) return res.status(400).json({ error: 'Invalid credentials' })
    const ok = await bcrypt.compare(password, u.passwordHash)
    if (!ok) return res.status(400).json({ error: 'Invalid credentials' })

    const token = signAccess({ sub: u._id.toString(), email: u.email, name: u.name, username: u.username || null, color: u.color })
    setAuthCookie(res, token)
    res.json({ user: { id: u._id, email: u.email, name: u.name, username: u.username || null, color: u.color } })
  } catch (err) {
    console.error('[signin] error', err)
    res.status(500).json({ error: 'Server error' })
  }
})

app.post('/api/auth/signout', (_req, res) => { clearAuthCookie(res); res.json({ ok: true }) })

app.get('/api/me', requireAuth, async (req, res) => {
  const u = await User.findById(req.user.sub).lean()
  if (!u) return res.status(404).json({ error: 'User not found' })
  res.json({ id: u._id, email: u.email, name: u.name, username: u.username || null, color: u.color })
})

/* ---- Boards ---- */
app.post('/api/boards', requireAuth, async (req, res) => {
  const b = await Board.create({
    title: req.body?.title || 'Untitled',
    document: { tldraw: null, ops: [], updatedAt: Date.now() },
    members: [{ userId: req.user.sub, role: 'owner' }],
  })
  res.json(b)
})

app.get('/api/boards', requireAuth, async (req, res) => {
  const boards = await Board.find({ 'members.userId': req.user.sub }).sort({ updatedAt: -1 })
  res.json(boards)
})

app.get('/api/boards/:id', async (req, res) => {
  const b = await Board.findById(req.params.id)
  if (!b) return res.status(404).json({ error: 'Not found' })

  // Auth (cookie) or token (viewer)
  let authedUserId = null
  const t = req.cookies?.access_token
  if (t) { try { authedUserId = jwt.verify(t, JWT_SECRET).sub } catch {} }
  if (authedUserId) {
    const isMember = b.members.find(m => String(m.userId) === String(authedUserId))
    if (!isMember) { b.members.push({ userId: authedUserId, role: 'editor' }); await b.save() }
  } else {
    const token = (req.query.token || '').toString()
    if (!(token && token === b.publicViewerToken)) return res.status(401).json({ error: 'Unauthenticated' })
  }

  if (b?.document?.tldraw) {
    b.document.tldraw = sanitizeTlSnapshotDeep(b.document.tldraw)
  }
  res.json(b)
})

/* ---- Members & roles ---- */
app.get('/api/boards/:id/members', requireAuth, async (req, res) => {
  const b = await Board.findById(req.params.id)
  if (!b) return res.status(404).json({ error: 'Not found' })
  const isMember = b.members.find(m => String(m.userId) === String(req.user.sub))
  if (!isMember) return res.status(403).json({ error: 'Forbidden' })

  const ids = b.members.map(m => m.userId)
  const users = await User.find({ _id: { $in: ids } }).select('_id name email username color').lean()
  const map = new Map(users.map(u => [u._id.toString(), u]))
  const result = b.members.map(m => ({
    userId: m.userId.toString(),
    role: m.role,
    name: map.get(m.userId.toString())?.name || 'User',
    email: map.get(m.userId.toString())?.email || '',
    color: map.get(m.userId.toString())?.color || '#7c3aed',
  }))
  res.json(result)
})

app.post('/api/boards/:id/members', requireAuth, async (req, res) => {
  const { email, role } = req.body || {}
  if (!email || !role) return res.status(400).json({ error: 'email and role required' })
  const b = await Board.findById(req.params.id)
  if (!b) return res.status(404).json({ error: 'Not found' })
  const me = b.members.find(m => String(m.userId) === String(req.user.sub))
  if (!me || me.role !== 'owner') return res.status(403).json({ error: 'Only owner can add members' })
  const u = await User.findOne({ email: String(email).toLowerCase() })
  if (!u) return res.status(404).json({ error: 'User not found' })

  const already = b.members.find(m => String(m.userId) === String(u._id))
  if (already) { already.role = role } else { b.members.push({ userId: u._id, role }) }
  await b.save()
  res.json({ ok: true })
})

app.patch('/api/boards/:id/members', requireAuth, async (req, res) => {
  const { userId, role } = req.body || {}
  if (!userId || !role) return res.status(400).json({ error: 'userId and role required' })
  const b = await Board.findById(req.params.id)
  if (!b) return res.status(404).json({ error: 'Not found' })
  const me = b.members.find(m => String(m.userId) === String(req.user.sub))
  if (!me || me.role !== 'owner') return res.status(403).json({ error: 'Only owner can change roles' })
  const m = b.members.find(x => String(x.userId) === String(userId))
  if (!m) return res.status(404).json({ error: 'Member not found' })
  if (m.role === 'owner' && role !== 'owner') {
    const owners = b.members.filter(x => x.role === 'owner')
    if (owners.length <= 1) return res.status(400).json({ error: 'Must keep at least one owner' })
  }
  m.role = role
  await b.save()
  res.json({ ok: true })
})

app.delete('/api/boards/:id/members/:userId', requireAuth, async (req, res) => {
  const b = await Board.findById(req.params.id)
  if (!b) return res.status(404).json({ error: 'Not found' })
  const me = b.members.find(m => String(m.userId) === String(req.user.sub))
  if (!me || me.role !== 'owner') return res.status(403).json({ error: 'Only owner can remove members' })

  const target = req.params.userId
  const idx = b.members.findIndex(m => String(m.userId) === String(target))
  if (idx < 0) return res.status(404).json({ error: 'Member not found' })
  if (b.members[idx].role === 'owner') {
    const owners = b.members.filter(x => x.role === 'owner')
    if (owners.length <= 1) return res.status(400).json({ error: 'Must keep at least one owner' })
  }
  b.members.splice(idx, 1)
  await b.save()
  res.json({ ok: true })
})

/* ---- Link preview (stub) ---- */
app.get('/api/link-preview', async (req, res) => {
  try {
    const url = String(req.query.url || '')
    if (!url) return res.status(400).json({ error: 'Missing url' })
    res.json({ url, title: null, description: null, image: null, siteName: null })
  } catch {
    res.json({ url: String(req.query.url || ''), title: null })
  }
})

/* ================ RECOVERY & EXPORT ====================== */
app.post('/api/boards/:id/snapshots', requireAuth, async (req, res) => {
  try {
    const boardId = req.params.id
    const board = await Board.findById(boardId)
    if (!board) return res.status(404).json({ error: 'Board not found' })
    const isMember = (board.members || []).some(m => String(m.userId) === String(req.user.sub))
    if (!isMember) return res.status(403).json({ error: 'Forbidden' })

    const tldraw = sanitizeTlSnapshotDeep(board.document?.tldraw || null)
    const checksum = hashObj(tldraw)
    const version = (await BoardSnapshot.countDocuments({ boardId })) + 1
    await BoardSnapshot.create({ boardId, version, tldraw, checksum })
    board.document = { ...(board.document || {}), updatedAt: Date.now(), tldraw }
    await board.save()
    return res.json({ ok: true, version, checksum })
  } catch (e) {
    console.error('[snapshot-now] failed', e)
    res.status(500).json({ error: 'Snapshot failed' })
  }
})

app.get('/api/boards/:id/export', requireAuth, async (req, res) => {
  try {
    const boardId = req.params.id
    const board = await Board.findById(boardId).lean()
    if (!board) return res.status(404).json({ error: 'Board not found' })
    const isMember = (board.members || []).some(m => String(m.userId) === String(req.user.sub))
    if (!isMember) return res.status(403).json({ error: 'Forbidden' })

    const latestSnap = await BoardSnapshot.findOne({ boardId }).sort({ version: -1 }).lean()
    const baseVersion = latestSnap?.version || 0
    const snapshot = latestSnap?.tldraw || board.document?.tldraw || null
    const ops = await BoardOp.find({ boardId }).sort({ seq: 1 }).lean()

    const payload = {
      meta: {
        exportedAt: new Date().toISOString(),
        boardId,
        title: board.title,
        baseVersion,
        checksum: latestSnap?.checksum || (snapshot ? hashObj(snapshot) : ''),
      },
      snapshot,
      ops,
      members: board.members || [],
      chat: board.chat || [],
    }
    const filename = (board.title || 'board').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/-+/g,'-') + '.export.json'
    res.setHeader('Content-Type', 'application/json')
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)
    res.status(200).send(JSON.stringify(payload, null, 2))
  } catch (e) {
    console.error('[export] failed', e)
    res.status(500).json({ error: 'Export failed' })
  }
})

/* =================== SOCKETS (base) ===================== */
// tiny cookie parser
function parseCookie(header = '') {
  const out = {}
  header.split(';').forEach(p => {
    const i = p.indexOf('=')
    if (i > -1) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1))
  })
  return out
}

// Attach userId from cookie
io.use((socket, next) => {
  try {
    const cookies = parseCookie(socket.request.headers?.cookie || '')
    const token = cookies['access_token']
    let userId = null
    if (token) { try { userId = jwt.verify(token, JWT_SECRET).sub } catch {} }
    socket.data.userId = userId
    socket.data.boardId = null
    socket.data.role = 'viewer'
    next()
  } catch (e) {
    next(e)
  }
})

/* ===== Presence store: room -> (socketId -> user) ===== */
const presenceByBoard = new Map()

/* ============== Merge/persist helpers for ops =========== */
function mergeOps(existing, incoming) {
  const map = new Map()
  ;[...existing, ...incoming].forEach(op => {
    const cur = map.get(op.id)
    if (!cur || op.ts >= cur.ts) map.set(op.id, op)
  })
  return Array.from(map.values()).sort((a, b) => a.ts - b.ts)
}

const _buffers = new Map() // boardId -> { ops:[], snapshot:null, timer:null }
function enqueuePersist(boardId, ops, snapshot) {
  let buf = _buffers.get(boardId)
  if (!buf) { buf = { ops: [], snapshot: null, timer: null }; _buffers.set(boardId, buf) }
  if (ops?.length) buf.ops.push(...ops)
  if (snapshot) buf.snapshot = snapshot
  if (!buf.timer) {
    buf.timer = setTimeout(async () => {
      const payload = _buffers.get(boardId)
      _buffers.delete(boardId)
      if (!payload) return
      try {
        const b = await Board.findById(boardId)
        const doc = b?.document || { tldraw: null, ops: [] }
        doc.ops = mergeOps(doc.ops || [], payload.ops || [])
        doc.updatedAt = Date.now()
        if (payload.snapshot) {
          const safe = sanitizeTlSnapshotDeep(payload.snapshot)
          if (safe) doc.tldraw = safe
        }
        await Board.findByIdAndUpdate(boardId, { $set: { document: doc } })
      } catch (e) {
        console.warn('[persist] failed', e?.message || e)
      }
    }, 150)
  }
}

/* =================== SOCKETS (events) =================== */
io.on('connection', (socket) => {
  console.log('[socket] connected', socket.id, 'user=', socket.data.userId)

  // Join a board room
  socket.on('room:join', async ({ boardId, token } = {}, ack) => {
    try {
      const b = await Board.findById(boardId).lean()
      if (!b) return ack?.({ ok: false, error: 'Board not found' })

      let role = 'viewer'
      if (socket.data.userId) {
        const m = (b.members || []).find(x => String(x.userId) === String(socket.data.userId))
        if (m) role = m.role
      } else {
        if (!(token && token === b.publicViewerToken)) return ack?.({ ok: false, error: 'Unauthenticated' })
      }

      if (socket.data.boardId && socket.data.boardId !== boardId) {
        const prev = socket.data.boardId
        socket.leave(prev)
        const map = presenceByBoard.get(prev)
        if (map && map.delete(socket.id)) {
          io.to(prev).emit('presence:leave', socket.id)
        }
      }

      socket.join(boardId)
      socket.data.boardId = boardId
      socket.data.role = role

      if (!presenceByBoard.has(boardId)) presenceByBoard.set(boardId, new Map())

      console.log('[socket] joined room', boardId, 'role=', role)
      ack?.({ ok: true, role })
    } catch (e) {
      console.warn('[room:join] error', e?.message || e)
      ack?.({ ok: false, error: 'Join failed' })
    }
  })

  /* ---------- Presence ---------- */
  // Accept presence even if it arrives just before room:join finishes.
  socket.on('presence:join', (user = {}) => {
    const incomingBoardId = user.boardId
    const boardId = socket.data.boardId || incomingBoardId
    if (!boardId) return
    if (!presenceByBoard.has(boardId)) presenceByBoard.set(boardId, new Map())
    const map = presenceByBoard.get(boardId)
    const record = { id: user.id, name: user.name || 'User', color: user.color || '#7c3aed', socketId: socket.id, boardId }
    map.set(socket.id, record)

    // Seed the full roster to the joining socket
    socket.emit('presence:roster', Array.from(map.values()))
    // Broadcast join to others in this board
    io.to(boardId).emit('presence:join', record)
  })

  socket.on('presence:list', (payload = {}, ack) => {
    const boardId = socket.data.boardId || payload.boardId
    if (!boardId) return ack?.({ ok: false })
    const map = presenceByBoard.get(boardId)
    const users = map ? Array.from(map.values()) : []
    ack?.({ ok: true, users })
  })

  socket.on('disconnect', () => {
    const boardId = socket.data.boardId
    if (!boardId) return
    const map = presenceByBoard.get(boardId)
    if (map && map.delete(socket.id)) {
      io.to(boardId).emit('presence:leave', socket.id)
      io.to(boardId).emit('cursor:leave', socket.id)
    }
  })

  /* ---------- Cursors & selections ---------- */
  socket.on('cursor:move', (c = {}) => { const b = socket.data.boardId || c.boardId; if (!b) return; io.to(b).emit('cursor:move', { ...c, boardId: b, socketId: socket.id }) })
  socket.on('cursor:active', (p = {}) => { const b = socket.data.boardId || p.boardId; if (!b) return; io.to(b).emit('cursor:active', { ...p, boardId: b, socketId: socket.id }) })
  socket.on('cursor:leave', (id)      => { const b = socket.data.boardId; if (!b) return; io.to(b).emit('cursor:leave', id || socket.id) })
  socket.on('selection:update', (sel = {}) => { const b = socket.data.boardId || sel.boardId; if (!b) return; io.to(b).emit('selection:update', { ...sel, boardId: b, socketId: socket.id }) })

  /* ---------- WebRTC signaling ---------- */
  socket.on('call:hello',  (p = {}) => { const b = socket.data.boardId || p.boardId; if (!b) return; io.to(b).emit('call:hello',  { ...p, boardId: b }) })
  socket.on('call:offer',  (p = {}) => { const b = socket.data.boardId || p.boardId; if (!b) return; io.to(b).emit('call:offer',  { ...p, boardId: b }) })
  socket.on('call:answer', (p = {}) => { const b = socket.data.boardId || p.boardId; if (!b) return; io.to(b).emit('call:answer', { ...p, boardId: b }) })
  socket.on('call:ice',    (p = {}) => { const b = socket.data.boardId || p.boardId; if (!b) return; io.to(b).emit('call:ice',    { ...p, boardId: b }) })
  socket.on('call:leave',  (p = {}) => { const b = socket.data.boardId || p.boardId; if (!b) return; io.to(b).emit('call:leave',  { ...p, boardId: b }) })
  socket.on('call:level',  (p = {}) => { const b = socket.data.boardId || p.boardId; if (!b) return; io.to(b).emit('call:level',  { ...p, boardId: b }) })

  /* ---------- Drawing ops ---------- */
  socket.on('board:ops', async (payload = {}, ack) => {
    const boardId = socket.data.boardId
    if (!boardId) return ack?.({ ok: false, error: 'no-room' })
    try {
      if (!['owner', 'editor'].includes(socket.data.role)) {
        return ack?.({ ok: false, error: 'read-only' })
      }
      const { ops = [], snapshot = null } = payload
      socket.to(boardId).emit('board:ops', { boardId, ops, snapshot })
      enqueuePersist(boardId, ops, snapshot)

      const session = await mongoose.startSession()
      await session.withTransaction(async () => {
        const arr = (ops || []).map(o => (typeof o === 'object' ? o : { op: o }))
        for (const item of arr) {
          const opId = item.opId || (item.op && item.op.id) || crypto.randomUUID()
          const exists = await BoardOp.findOne({ boardId, opId }).session(session)
          if (exists) continue
          const seq = await nextBoardSeq(boardId, session)
          await BoardOp.create([{
            boardId,
            seq,
            opId,
            op: item.op || item,
            authorId: socket.data.userId || null,
          }], { session })
        }

        const countOps = await BoardOp.countDocuments({ boardId }).session(session)
        if (countOps % 200 === 0) {
          const b = await Board.findById(boardId).session(session)
          if (b) {
            const checksum = hashObj(b.document?.tldraw)
            const version = (await BoardSnapshot.countDocuments({ boardId }).session(session)) + 1
            await BoardSnapshot.create([{ boardId, version, tldraw: b.document?.tldraw || null, checksum }], { session })
          }
        }
      })
      session.endSession()
      ack?.({ ok: true })
    } catch (e) {
      console.warn('[board:ops] error', e?.message || e)
      ack?.({ ok: false, error: 'persist failed' })
    }
  })

  socket.on('board:snapshot:request', async (_payload, ack) => {
    const boardId = socket.data.boardId
    if (!boardId) { ack?.({ ok: false }); return }
    const b = await Board.findById(boardId)
    let doc = b?.document || null
    if (doc?.tldraw) {
      const safe = sanitizeTlSnapshotDeep(doc.tldraw)
      if (safe) doc = { ...doc, tldraw: safe }
    }
    socket.emit('board:snapshot:response', { boardId, doc })
    ack?.({ ok: true })
  })

  /* ---------- Chat ---------- */
  socket.on('chat:typing', (p = {}) => {
    const boardId = socket.data.boardId || p.boardId
    if (!boardId) return
    io.to(boardId).emit('chat:typing', { ...p, boardId })
  })

  socket.on('chat:message', async (msg = {}, ack) => {
    const boardId = socket.data.boardId || msg.boardId
    if (!boardId) return ack?.({ ok: false })

    try {
      const b = await Board.findById(boardId)
      if (!b) return ack?.({ ok: false })

      let displayName = msg?.name
      if (msg?.userId && !displayName) {
        const u = await User.findById(msg.userId).lean()
        if (u) displayName = u.name || u.email
      }
      if (!displayName) displayName = 'User'

      const clean = {
        id: String(msg.id || Date.now() + '_' + Math.random().toString(36).slice(2, 8)),
        userId: String(msg.userId || ''),
        name: String(displayName),
        text: String(msg.text || ''),
        replyTo: msg.replyTo ? String(msg.replyTo) : null,
        reactions: msg.reactions || {},
        linkPreview: msg.linkPreview || null,
        ts: Number(msg.ts || Date.now()),
        boardId,
      }

      const next = (Array.isArray(b.chat) ? b.chat : []).concat([clean]).slice(-2000)
      await Board.findByIdAndUpdate(boardId, { $set: { chat: next } })

      io.to(boardId).emit('chat:message', clean)
      ack?.({ ok: true })
    } catch (e) {
      console.warn('[chat:message] error', e?.message || e)
      ack?.({ ok: false })
    }
  })

  socket.on('chat:react', async ({ messageId, emoji, userId, toggle = true, boardId: pBoard } = {}, ack) => {
    const boardId = socket.data.boardId || pBoard
    if (!boardId) return ack?.({ ok: false })
    try {
      const b = await Board.findById(boardId)
      if (!b) return ack?.({ ok: false })
      const chat = Array.isArray(b.chat) ? b.chat : []
      const i = chat.findIndex(m => m.id === messageId)
      if (i >= 0) {
        const reactions = chat[i].reactions || {}
        const set = new Set(reactions[emoji] || [])
        if (toggle === false) set.delete(userId); else set.add(userId)
        reactions[emoji] = Array.from(set)
        chat[i] = { ...chat[i], reactions }
        await Board.findByIdAndUpdate(boardId, { $set: { chat } })
        io.to(boardId).emit('chat:react', { boardId, messageId, emoji, userId, toggle })
      }
      ack?.({ ok: true })
    } catch (e) {
      console.warn('[chat:react] error', e?.message || e)
      ack?.({ ok: false })
    }
  })
})

/* ================= ERROR HANDLERS ======================== */
app.use('/api/*', (req, res) => {
  res.status(404).json({ ok: false, error: 'Not found', path: req.originalUrl })
})

app.use((err, req, res, _next) => {
  console.error('[api error]', err)
  if (req.path?.startsWith?.('/api')) {
    return res.status(500).json({ ok: false, error: 'Server error' })
  }
  res.status(500).send('Server error')
})

/* ===================== AI (optional) ===================== */
async function aiChatHandler(req, res) {
  try {
    const { messages = [] } = req.body || {}
    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ ok: false, error: 'messages[] required' })
    }
    const provider = (process.env.AI_PROVIDER || 'ollama').toLowerCase()
    if (provider === 'ollama') {
      const base  = process.env.OLLAMA_URL   || 'http://localhost:11434'
      const model = process.env.OLLAMA_MODEL || 'llama3.1:8b'
      const r = await fetch(`${base}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, messages, stream: false, options: { temperature: 0.3 } })
      })
      const text = await r.text()
      if (!r.ok) return res.status(502).json({ ok: false, error: `ollama error: ${text.slice(0,200)}` })
      let data; try { data = JSON.parse(text) } catch { data = {} }
      const answer = data?.message?.content || data?.response || ''
      return res.json({ ok: true, provider: 'ollama', model, text: answer })
    }
    if (provider === 'openai') {
      const key   = process.env.OPENAI_API_KEY || ''
      const base  = process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1'
      const model = process.env.OPENAI_MODEL || 'gpt-4o-mini'
      if (!key) return res.status(500).json({ ok: false, error: 'OPENAI_API_KEY missing' })
      const r = await fetch(`${base}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
        body: JSON.stringify({ model, messages, temperature: 0.3 })
      })
      const text = await r.text()
      if (!r.ok) return res.status(502).json({ ok: false, error: `openai error: ${text.slice(0,200)}` })
      let data; try { data = JSON.parse(text) } catch { data = {} }
      const answer = data?.choices?.[0]?.message?.content || ''
      return res.json({ ok: true, provider: 'openai', model, text: answer })
    }
    return res.json({ ok: true, provider: 'none', text: 'AI is not configured on the server.' })
  } catch (e) {
    console.error('[AI] /api/ai/chat error', e)
    return res.status(500).json({ ok: false, error: 'AI server error' })
  }
}
app.post('/api/ai/chat', aiChatHandler)
app.post('/api/ai/ask', aiChatHandler)

/* ===================== STARTUP =========================== */
mongoose.set('strictQuery', false)
mongoose
  .connect(MONGO_URL)
  .then(() => {
    console.log('[mongo] connected:', MONGO_URL)
    httpServer.listen(PORT, '0.0.0.0', () => {
      console.log(`[server] listening on 0.0.0.0:${PORT} | client: ${CLIENT_URL}`)
    })
  })
  .catch(err => { console.error('[mongo] connection error:', err?.message || err); process.exit(1) })

io.engine.on('connection_error', err => { console.warn('[socket.io] connection_error', err?.message) })
process.on('unhandledRejection', err => console.error('[unhandledRejection]', err))
process.on('uncaughtException', err => console.error('[uncaughtException]', err))
