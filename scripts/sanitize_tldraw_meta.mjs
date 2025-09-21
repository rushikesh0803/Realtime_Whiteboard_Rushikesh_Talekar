import { MongoClient } from "mongodb"

const MONGO_URL = process.env.MONGO_URL || "mongodb://127.0.0.1:27017/whiteboard"

function forceMetaOnRecord(rec) {
  if (!rec || typeof rec !== "object") return
  const type = rec.typeName || rec.type
  const isDoc =
    type === "tl_document" ||
    type === "document" ||
    (rec.id && String(rec.id).startsWith("document:"))

  if (isDoc) {
    if (rec.meta == null) rec.meta = {}
    if (rec.value && rec.value.meta == null) rec.value.meta = {}
    if (rec.props && rec.props.meta == null) rec.props.meta = {}
  }
}

function sanitizeSnapshot(snap) {
  if (!snap || typeof snap !== "object") return snap
  if (snap.document && snap.document.meta == null) snap.document.meta = {}

  const recs = []
  const r1 = snap?.store?.records
  const r2 = snap?.records
  if (Array.isArray(r1)) recs.push(...r1)
  else if (r1 && typeof r1 === "object") recs.push(...Object.values(r1))
  if (Array.isArray(r2)) recs.push(...r2)
  else if (r2 && typeof r2 === "object") recs.push(...Object.values(r2))

  recs.forEach(forceMetaOnRecord)
  return snap
}

const client = new MongoClient(MONGO_URL)
await client.connect()
const db = client.db()
const boards = db.collection("boards")

let scanned = 0, fixed = 0
const cursor = boards.find({ "document.tldraw": { $ne: null } })
for await (const b of cursor) {
  scanned++
  const before = b.document.tldraw
  const after = sanitizeSnapshot(JSON.parse(JSON.stringify(before)))
  if (JSON.stringify(before) !== JSON.stringify(after)) {
    await boards.updateOne({ _id: b._id }, { $set: { "document.tldraw": after } })
    fixed++
  }
}
console.log(`Scanned: ${scanned} | Updated: ${fixed}`)
await client.close()
