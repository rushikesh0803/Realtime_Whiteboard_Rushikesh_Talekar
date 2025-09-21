// src/components/BoardsList.jsx
import React, { useEffect, useMemo, useState } from 'react';

function RoleBadge({ role }) {
  const cls = {
    owner: 'bg-indigo-600/10 text-indigo-700 dark:text-indigo-300 border-indigo-500/40',
    editor: 'bg-emerald-600/10 text-emerald-700 dark:text-emerald-300 border-emerald-500/40',
    viewer: 'bg-zinc-600/10 text-zinc-700 dark:text-zinc-300 border-zinc-500/40',
  }[role] || 'bg-zinc-600/10 text-zinc-700 dark:text-zinc-300 border-zinc-500/40';
  return <span className={`text-[11px] px-2 py-0.5 rounded border ${cls}`}>{role}</span>;
}

function fmtTime(iso) {
  const d = new Date(iso);
  const now = Date.now();
  const delta = Math.floor((now - d.getTime()) / 1000);
  if (delta < 60) return 'just now';
  if (delta < 3600) return `${Math.floor(delta / 60)}m ago`;
  if (delta < 86400) return `${Math.floor(delta / 3600)}h ago`;
  return d.toLocaleString();
}

export default function BoardsList({ onOpen }) {
  const [boards, setBoards] = useState([]);
  const [q, setQ] = useState('');
  const [sort, setSort] = useState('updatedAt_desc'); // 'updatedAt_desc' | 'updatedAt_asc' | 'title_asc' | 'title_desc'
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState('');

  async function load() {
    setLoading(true);
    try {
      const r = await fetch(`/api/boards${q ? `?q=${encodeURIComponent(q)}` : ''}`, { credentials: 'include' });
      const data = r.ok ? await r.json() : [];
      setBoards(Array.isArray(data) ? data : []);
    } catch {
      setBoards([]);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, []); // initial

  const filtered = useMemo(() => {
    const arr = [...boards];
    arr.sort((a, b) => {
      switch (sort) {
        case 'updatedAt_desc': return new Date(b.updatedAt) - new Date(a.updatedAt);
        case 'updatedAt_asc': return new Date(a.updatedAt) - new Date(b.updatedAt);
        case 'title_asc': return (a.title || '').localeCompare(b.title || '');
        case 'title_desc': return (b.title || '').localeCompare(a.title || '');
        default: return 0;
      }
    });
    return arr;
  }, [boards, sort]);

  async function createBoard() {
    try {
      setCreating(true);
      const r = await fetch('/api/boards', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: title.trim() || 'Untitled' }),
      });
      if (!r.ok) throw new Error('create failed');
      const b = await r.json();
      onOpen({ id: b._id, token: '' });
    } catch {
      alert('Could not create board.');
    } finally {
      setCreating(false);
    }
  }

  async function copyPublicLink(board) {
    try {
      // get existing; if disabled, enable it automatically
      let r = await fetch(`/api/boards/${board._id}/public-link`, { credentials: 'include' });
      if (!r.ok) throw new Error();
      let data = await r.json();
      if (!data.enabled) {
        r = await fetch(`/api/boards/${board._id}/public-link`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ enabled: true }),
        });
        if (!r.ok) throw new Error();
        data = await r.json();
      }
      if (!data.url) throw new Error();
      await navigator.clipboard.writeText(data.url);
      alert('Public viewer link copied!');
    } catch {
      alert('Could not get public link. (You must be owner/editor.)');
    }
  }

  return (
    <div className="space-y-4">
      {/* Create / Search / Sort */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
        <div className="flex gap-2">
          <input
            className="input flex-1"
            placeholder="New board title…"
            value={title}
            onChange={(e)=>setTitle(e.target.value)}
          />
          <button className="btn whitespace-nowrap" onClick={createBoard} disabled={creating}>
            {creating ? 'Creating…' : 'Create'}
          </button>
        </div>

        <div className="flex gap-2">
          <input
            className="input flex-1"
            placeholder="Search my boards…"
            value={q}
            onChange={(e)=>setQ(e.target.value)}
            onKeyDown={(e)=>{ if (e.key === 'Enter') load(); }}
          />
          <button className="btn" onClick={load}>Search</button>
        </div>

        <div className="flex gap-2 items-center">
          <select className="input flex-1" value={sort} onChange={(e)=>setSort(e.target.value)}>
            <option value="updatedAt_desc">Last edited ↓</option>
            <option value="updatedAt_asc">Last edited ↑</option>
            <option value="title_asc">Title A→Z</option>
            <option value="title_desc">Title Z→A</option>
          </select>
          <button className="btn" onClick={load}>↻</button>
        </div>
      </div>

      {/* Table */}
      <div className="border rounded-xl overflow-hidden">
        <div className="grid grid-cols-12 px-3 py-2 text-xs uppercase tracking-wide bg-black/5 dark:bg-white/10">
          <div className="col-span-6">Title</div>
          <div className="col-span-2">Role</div>
          <div className="col-span-2">Last edited</div>
          <div className="col-span-2 text-right">Actions</div>
        </div>

        {loading ? (
          <div className="p-4 text-sm opacity-70">Loading…</div>
        ) : filtered.length === 0 ? (
          <div className="p-4 text-sm opacity-70">No boards found.</div>
        ) : (
          <ul className="divide-y">
            {filtered.map((b) => {
              // find my role from members
              const meMember = (b.members || []).find(m => (m.userId === b.me?.id) || (m.userId?._id === b.me?.id)) || (b.members || [])[0];
              const role = meMember?.role || 'viewer';
              return (
                <li key={b._id} className="grid grid-cols-12 items-center px-3 py-2">
                  <div className="col-span-6 truncate">
                    <div className="font-medium truncate">{b.title || 'Untitled'}</div>
                    <div className="text-xs opacity-60">#{b._id}</div>
                  </div>
                  <div className="col-span-2"><RoleBadge role={role} /></div>
                  <div className="col-span-2 text-sm opacity-80">{fmtTime(b.updatedAt)}</div>
                  <div className="col-span-2 flex justify-end gap-2">
                    <button className="btn" onClick={()=>onOpen({ id: b._id, token: '' })}>Open</button>
                    <button className="btn-outline" onClick={()=>copyPublicLink(b)}>Public link</button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
