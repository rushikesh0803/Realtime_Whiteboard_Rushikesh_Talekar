import mongoose from 'mongoose'

const MONGO_URL = process.env.MONGO_URL || 'mongodb://127.0.0.1:27017/whiteboard'
const BoardSchema = new mongoose.Schema({ document: Object }, { strict: false })
const Board = mongoose.model('Board', BoardSchema, 'boards')

function ensureDocMetaOnRecord(rec) {
  if (!rec) return
  const t = rec.typeName || rec.type
  if (t === 'tl_document' || t === 'document') {
    if (rec.meta == null) rec.meta = {}
    if (rec.value && typeof rec.value === 'object' && rec.value.meta == null) rec.value.meta = {}
  }
}
function fixChanges(ch) {
  if (!ch) return
  if (ch.added) {
    const list = Array.isArray(ch.added) ? ch.added : Object.values(ch.added)
    list.forEach(ensureDocMetaOnRecord)
  }
  if (ch.updated) {
    Object.values(ch.updated).forEach(u => {
      if (u?.next) ensureDocMetaOnRecord(u.next)
      if (u?.prev) ensureDocMetaOnRecord(u.prev)
    })
  }
}
function fixSnapshot(snap) {
  if (!snap || typeof snap !== 'object') return snap
  try {
    const s = JSON.parse(JSON.stringify(snap))
    if (s.document && s.document.meta == null) s.document.meta = {}
    let recs = []
    const r1 = s?.store?.records, r2 = s?.records
    if (Array.isArray(r1)) recs = r1
    else if (r1 && typeof r1 === 'object') recs = Object.values(r1)
    else if (Array.isArray(r2)) recs = r2
    else if (r2 && typeof r2 === 'object') recs = Object.values(r2)
    recs.forEach(ensureDocMetaOnRecord)
    return s
  } catch { return snap }
}

async function run() {
  await mongoose.connect(MONGO_URL)
  console.log('[sanitize] connected:', MONGO_URL)

  const cursor = Board.find({}).cursor()
  let scanned = 0, fixed = 0
  for await (const b of cursor) {
    scanned++
    let changed = false
    if (b?.document?.tldraw) {
      const safe = fixSnapshot(b.document.tldraw)
      if (JSON.stringify(safe) !== JSON.stringify(b.document.tldraw)) {
        b.document.tldraw = safe
        changed = true
      }
    }
    if (Array.isArray(b?.document?.ops)) {
      let touched = false
      b.document.ops.forEach(op => {
        if (op?.changes) {
          const before = JSON.stringify(op.changes)
          fixChanges(op.changes)
          const after = JSON.stringify(op.changes)
          if (before !== after) touched = true
        }
      })
      if (touched) changed = true
    }
    if (changed) { await b.save(); fixed++; console.log('[sanitize] fixed board', b._id.toString()) }
  }
  console.log(`[sanitize] done. scanned=${scanned}, fixed=${fixed}`)
  await mongoose.disconnect()
}
run().catch(e => { console.error(e); process.exit(1) })
