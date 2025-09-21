import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import 'dotenv/config';

const HEX6 = /^#([0-9a-fA-F]{6})$/;

// --- Schemas ---
const userSchema = new mongoose.Schema({
  email: { type: String, unique: true, index: true },
  name: String,
  passwordHash: String,
  color: {
    type: String,
    default: '#7c3aed',
    validate: {
      validator: v => !v || HEX6.test(v),
      message: props => `${props.value} is not a valid 6-digit hex color (e.g., #3b82f6)`
    }
  }
}, { timestamps: true });

const boardSchema = new mongoose.Schema({
  title: String,
  document: { type: Object, default: { tldraw: null, ops: [], updatedAt: Date.now() } },
  members: [{
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    role: { type: String, enum: ['owner','editor','viewer'], default: 'owner' }
  }]
}, { timestamps: true });

const User = mongoose.model('User', userSchema);
const Board = mongoose.model('Board', boardSchema);

// --- Seed data ---
const USERS = [
  { name: 'Rushikesh Talekar', email: '2203051050504@paruluniversity.ac.in' },
  { name: 'Ayush Navale',      email: '2203051050111@paruluniversity.ac.in' },
  { name: 'Saurabh Shinde',    email: '2203051050524@paruluniversity.ac.in' },
  { name: 'Om Gharte',         email: '2203051050390@paruluniversity.ac.in' },
];

// Vivid readable palette
const COLOR_PALETTE = [
  '#7c3aed', // violet
  '#10b981', // emerald
  '#f59e0b', // amber
  '#ef4444', // red
  '#3b82f6', // blue
  '#ec4899', // pink
  '#14b8a6', // teal
  '#a855f7', // purple
];

// --- Helpers ---
function boardDoc(title) {
  return { title, document: { tldraw: null, ops: [], updatedAt: Date.now() } };
}

// Stable hash so the same email always maps to the same palette index
function hashEmail(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h) ^ str.charCodeAt(i);
  return Math.abs(h);
}
function colorForEmail(email) {
  return COLOR_PALETTE[hashEmail(email) % COLOR_PALETTE.length];
}

async function backfillUserColors() {
  // Find users with missing/invalid colors
  const candidates = await User.find({
    $or: [
      { color: { $exists: false } },
      { color: null },
      { color: '' },
      { color: { $not: HEX6 } }  // relies on server-side regex
    ]
  });

  let updated = 0;
  for (const u of candidates) {
    const newColor = colorForEmail(u.email);
    if (u.color !== newColor) {
      u.color = newColor;
      await u.save();
      updated++;
      console.log(`🎨 Backfilled color for ${u.email} → ${newColor}`);
    }
  }
  if (updated === 0) console.log('✅ No user color backfills needed.');
  else console.log(`✅ Backfilled ${updated} user(s) with palette colors.`);
}

async function run() {
  const mongo = process.env.MONGO_URL || 'mongodb://127.0.0.1:27017/whiteboard';
  await mongoose.connect(mongo);
  console.log('Connected:', mongo);

  const passHash = await bcrypt.hash('password', 12);
  const users = [];

  // Ensure seed users exist, assign palette color on create
  for (const u of USERS) {
    let doc = await User.findOne({ email: u.email });
    if (!doc) {
      const color = colorForEmail(u.email);
      doc = await User.create({ ...u, passwordHash: passHash, color });
      console.log('✅ User created:', u.email, 'with color', color);
    } else {
      // If existing user has bad/missing color, fix it deterministically
      if (!doc.color || !HEX6.test(doc.color)) {
        const color = colorForEmail(doc.email);
        doc.color = color;
        await doc.save();
        console.log('🛠️  Fixed color for existing user:', doc.email, '→', color);
      } else {
        console.log('⚡ User exists:', u.email);
      }
    }
    users.push(doc);
  }

  // Global backfill for any legacy users (outside the seed list) missing color
  await backfillUserColors();

  // Personal boards
  for (const u of users) {
    const title = `Personal Board - ${u.name.split(' ')[0]}`;
    const exists = await Board.findOne({ title, 'members.userId': u._id });
    if (!exists) {
      await Board.create({ ...boardDoc(title), members: [{ userId: u._id, role: 'owner' }] });
      console.log('🧩 Created board:', title);
    } else {
      console.log('🔁 Board exists:', title);
    }
  }

  // Shared board
  const sharedTitle = 'Class Project Board';
  const sharedExists = await Board.findOne({ title: sharedTitle });
  if (!sharedExists) {
    await Board.create({
      ...boardDoc(sharedTitle),
      members: [
        { userId: users[0]._id, role: 'owner' },
        ...users.slice(1).map(u => ({ userId: u._id, role: 'editor' }))
      ]
    });
    console.log('🤝 Created shared board:', sharedTitle);
  } else {
    console.log('🔁 Shared board exists:', sharedTitle);
  }

  await mongoose.disconnect();
  console.log('Done.');
}

run().catch(e => { console.error(e); process.exit(1); });
