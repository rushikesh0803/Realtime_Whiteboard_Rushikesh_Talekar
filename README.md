# Realtime Collaborative Whiteboard
- React + Vite + Tailwind + tldraw
- Express + Socket.IO + MongoDB (Mongoose), JWT cookies (email/password)
- Floating FAB (bottom-right): Chat 💬 / Share 🔗 / Voice 🎙️
  - Chat: replies, reactions, link preview
  - Share: exports PNG + link (Web Share API + fallbacks)
  - Voice: WebRTC voice-only (mesh), mute/end
- `seed.js` creates 4 users (password `password`) + personal boards + shared "Class Project Board"

## Run
```bash
npm i
cp .env.example .env
npm run seed
npm run server   # :4000
npm run dev      # :5173
```

Login with: 2203051050504@paruluniversity.ac.in / password (or the other 3)
Open: http://localhost:5173/?id=demo
