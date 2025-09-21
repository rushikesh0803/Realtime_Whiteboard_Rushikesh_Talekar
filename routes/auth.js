// server/routes/auth.js
import express from 'express'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import User from '../models/user.js'

const router = express.Router()

const NODE_ENV = process.env.NODE_ENV || 'development'
const JWT_SECRET = process.env.JWT_SECRET || 'dev_super_secret_change_me'

function signAccess(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '7d' })
}
function setAuthCookie(res, token) {
  const secure = NODE_ENV === 'production'
  res.cookie('access_token', token, {
    httpOnly: true,
    sameSite: secure ? 'none' : 'lax',
    secure,
    path: '/',
    maxAge: 7 * 24 * 60 * 60 * 1000,
  })
}
function sanitizeEmail(e) { return String(e || '').trim().toLowerCase() }
function sanitizeStr(s) { return String(s || '').trim() }

// POST /api/auth/signup
router.post('/signup', async (req, res) => {
  try {
    const name = sanitizeStr(req.body?.name)
    const email = sanitizeEmail(req.body?.email)
    const username = sanitizeStr(req.body?.username || '')
    const password = String(req.body?.password || '')

    if (!name || !email || !password) return res.status(400).json({ error: 'Missing required fields' })
    if (password.length < 6) return res.status(400).json({ error: 'Password too short (min 6)' })

    if (await User.findOne({ email })) return res.status(409).json({ error: 'Email already exists' })
    if (username && await User.findOne({ username })) return res.status(409).json({ error: 'Username already exists' })

    const passwordHash = await bcrypt.hash(password, 12)
    const user = await User.create({
      name,
      email,
      username: username || undefined,
      passwordHash,
      // color default comes from schema
    })

    const token = signAccess({
      sub: user._id.toString(),
      email: user.email,
      name: user.name,
      username: user.username || null,
      color: user.color,
    })
    setAuthCookie(res, token)

    return res.status(201).json({
      ok: true,
      user: { id: user._id, email: user.email, name: user.name, username: user.username || null, color: user.color },
    })
  } catch (err) {
    if (err?.code === 11000) {
      return res.status(409).json({ error: 'Email or username already exists' })
    }
    console.error('[signup] error', err)
    res.status(500).json({ error: 'Server error' })
  }
})

// POST /api/auth/signin  (email OR username)
router.post('/signin', async (req, res) => {
  try {
    const rawEmail = sanitizeStr(req.body?.email || '')
    const rawUsername = sanitizeStr(req.body?.username || '')
    const password = String(req.body?.password || '')

    if (!rawEmail && !rawUsername) return res.status(400).json({ error: 'Email or username required' })
    if (!password) return res.status(400).json({ error: 'Password required' })

    const query = rawEmail ? { email: sanitizeEmail(rawEmail) } : { username: rawUsername }
    const u = await User.findOne(query)
    if (!u || !(await bcrypt.compare(password, u.passwordHash))) {
      return res.status(400).json({ error: 'Invalid credentials' })
    }

    const token = signAccess({
      sub: u._id.toString(),
      email: u.email,
      name: u.name,
      username: u.username || null,
      color: u.color,
    })
    setAuthCookie(res, token)

    res.json({ ok: true, user: { id: u._id, email: u.email, name: u.name, username: u.username || null, color: u.color } })
  } catch (err) {
    console.error('[signin] error', err)
    res.status(500).json({ error: 'Server error' })
  }
})

// POST /api/auth/signout
router.post('/signout', (_req, res) => {
  res.cookie('access_token', '', {
    httpOnly: true, sameSite: 'lax', secure: false, path: '/', maxAge: 0,
  })
  res.json({ ok: true })
})

export default router
