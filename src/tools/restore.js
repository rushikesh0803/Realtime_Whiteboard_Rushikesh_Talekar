// tools/restore.js
// Restore a board from an export JSON produced by /api/boards/:id/export
// Usage:
//   node tools/restore.js /absolute/path/to/board.export.json
//
// Notes:
// - Requires MONGO_URL env (falls back to .env via dotenv).
// - Idempotent on ops via (boardId, opId).
// - Recomputes the per-board op sequence counter to max(seq).
// - If board doesn't exist, it will be created with same title/members/chat/snapshot.
// - If it exists, snapshot will be set if newer; chat/messages are merged (dedupe on ts+userId+text).

import 'dotenv/config'
import mongoose from 'mongoose'
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'

const MONGO_URL = process.env.MONGO_URL || 'mongodb://127.0.0.1:27017/whiteboard'

// --- Minimal schemas (mirror server.js) ---
const counterSchema = new mongoose.Schema({ _id: String, seq: { type: Number, default: 0 } })
const Counter = mongoose.model('Counter', counterSchema)

const userSchema = new mongoose.Schema({
  email: { type: String, unique: true, index: true },
  username: { type: String, unique: true, sparse: true },
  name: String,
  passwordHash: String,
  color: String,
}, { timestamps: true })
const User = mongoose.model('User', userSchema)

const boardSchema = new mongoose.Schema({
  title: String,
  document: { type: Object, default: { tldraw: null, ops: [], updatedAt: Date.now() } },
  members: [{ userId: mongoose.Schema.Types.ObjectId, role: String }],
  chat: [{
    userId: mongoose.Schema.Types.ObjectId,
    name: String,
    text: String,
    replyTo: String,
    reactions: Object,
    linkPreview: Object,
    ts: Number,
  }],
  publicViewerToken: { type: String, default: '' },
}, { timestamps: true })
const Board = mongoose.model('Board', boardSchema)

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

function hashObj(obj) {
  const s = JSON.stringify(obj || {})
  return crypto.createHash('sha256').update(s).digest('hex')
}

async function main() {
  const filePath = process.argv[2]
  if (!filePath) {
    console.error('Usage: node tools/restore.js /path/to/export.json')
    process.exit(1)
  }
  const raw = fs.readFileSync(path.resolve(filePath), 'utf-8')
  const payload = JSON.parse(raw)

  await mongoose.connect(MONGO_URL)
  console.log('[restore] connected to', MONGO_URL)

  const { meta, snapshot, ops, members, chat } = payload
  let boardId = payload.meta?.boardId
  const title = String(meta?.title || 'Recovered Board')
  console.log('[restore] source boardId:', boardId, 'title:', title)

  // if board exists use it, else create
  let board = boardId ? await Board.findById(boardId) : null
  if (!board) {
    board = await Board.create({
      _id: boardId || undefined,
      title,
      document: { tldraw: snapshot || null, ops: [], updatedAt: Date.now() },
      members: members || [],
      chat: chat || [],
    })
    boardId = board._id.toString()
    console.log('[restore] created new board:', boardId)
  } else {
    // merge: keep newer snapshot
    const currentSnap = board.document?.tldraw
    const curHash = currentSnap ? hashObj(currentSnap) : ''
    const newHash = snapshot ? hashObj(snapshot) : ''
    if (newHash && newHash !== curHash) {
      board.document = { ...(board.document || {}), tldraw: snapshot, updatedAt: Date.now() }
    }

    // merge members (dedupe by userId)
    const mergedMembers = new Map()
    ;[...(board.members || []), ...(members || [])].forEach(m => {
      mergedMembers.set(String(m.userId), m)
    })
    board.members = Array.from(mergedMembers.values())

    // merge chat (dedupe naive by ts+userId+text)
    const seen = new Set()
    const mergedChat = []
    ;[...(board.chat || []), ...(chat || [])].forEach(c => {
      const k = `${c.ts}-${c.userId}-${(c.text||'').slice(0,200)}`
      if (seen.has(k)) return
      seen.add(k); mergedChat.push(c)
    })
    board.chat = mergedChat

    await board.save()
    console.log('[restore] updated existing board:', boardId)
  }

  // restore snapshot record (version = next)
  const latestVersion = await BoardSnapshot.countDocuments({ boardId })
  const checksum = snapshot ? hashObj(snapshot) : ''
  if (snapshot) {
    await BoardSnapshot.create({ boardId, version: latestVersion + 1, tldraw: snapshot, checksum })
    console.log('[restore] wrote snapshot version', latestVersion + 1)
  }

  // insert ops idempotently with seq
  let maxSeq = 0
  for (const item of (ops || [])) {
    try {
      const exists = await BoardOp.findOne({ boardId, opId: item.opId })
      if (exists) { maxSeq = Math.max(maxSeq, exists.seq || 0); continue }
      const created = await BoardOp.create({
        boardId,
        seq: item.seq, // keep original seq if present
        opId: item.opId || crypto.randomUUID(),
        op: item.op || item,
        authorId: item.authorId || null,
        ts: item.ts || new Date(),
      })
      maxSeq = Math.max(maxSeq, created.seq || 0)
    } catch (e) {
      // If duplicate key on (boardId, opId), ignore
      if (!String(e).includes('E11000')) {
        console.warn('[restore] op insert failed:', e.message || e)
      }
    }
  }

  // ensure counter is at least maxSeq
  const key = `board:${boardId}:op_seq`
  const doc = await Counter.findOne({ _id: key })
  if (!doc) {
    await Counter.create({ _id: key, seq: maxSeq })
  } else if ((doc.seq || 0) < maxSeq) {
    doc.seq = maxSeq
    await doc.save()
  }
  console.log('[restore] set counter', key, 'to', maxSeq)

  await mongoose.disconnect()
  console.log('[restore] done.')
}

main().catch(e => { console.error(e); process.exit(1) })
