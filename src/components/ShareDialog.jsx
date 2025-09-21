// src/components/ShareDialog.jsx
import React, { useEffect, useMemo, useState } from 'react';
import {
  exportBlob,
  downloadBlob,
  copyBlobToClipboard,
  copyText,
  socialUrl,
  popup,
  maybeUploadToServer,
  tryWebShare,
} from '../lib/share.js';

const FORMATS = ['png', 'jpg', 'webp', 'pdf']; // raster only

export default function ShareDialog({
  open,
  onClose,
  editor,
  boardUrl,
  defaultFormat = 'png', // 'png' | 'jpg' | 'webp' | 'pdf'
  message = 'Check out this whiteboard',
}) {
  const [format, setFormat] = useState(
    FORMATS.includes((defaultFormat || '').toLowerCase())
      ? defaultFormat.toLowerCase()
      : 'png'
  );
  const [scale, setScale] = useState(2);
  const [background, setBackground] = useState(true);
  const [uploadImage, setUploadImage] = useState(false);
  const [busy, setBusy] = useState(false);
  const [blob, setBlob] = useState(null);
  const [error, setError] = useState('');

  // Use raster extension even for "pdf" (we print PNG)
  const filename = useMemo(() => {
    const ext = format === 'pdf' ? 'png' : format;
    return `whiteboard.${ext}`;
  }, [format]);

  // Export on open / param changes (raster only)
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setError('');
    setBlob(null);

    (async () => {
      if (!editor) {
        setError('Editor not ready');
        return;
      }
      setBusy(true);
      try {
        const b = await exportBlob({ editor, format, scale, background });
        if (!cancelled) setBlob(b);
      } catch (e) {
        console.error('[ShareDialog] export error', e);
        if (!cancelled) setError(e?.message || 'Export failed. Try PNG instead.');
      } finally {
        if (!cancelled) setBusy(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [open, editor, format, scale, background]);

  if (!open) return null;

  const hasClipboardImage =
    'ClipboardItem' in window && !!navigator.clipboard?.write;
  const canSystemShare = !!(navigator.canShare && navigator.share);

  // Ensure filename extension matches blob type (best effort)
  function ensureFilenameForBlob(name, b) {
    try {
      const type = (b?.type || '').toLowerCase();
      let ext = 'png';
      if (type.includes('jpeg') || type.endsWith('/jpg')) ext = 'jpg';
      else if (type.includes('webp')) ext = 'webp';
      else if (type.includes('png')) ext = 'png';
      if (!name.toLowerCase().endsWith(`.${ext}`)) {
        name = name.replace(/\.(png|jpg|jpeg|webp)$/i, '') + `.${ext}`;
      }
      return name;
    } catch {
      return name || 'whiteboard.png';
    }
  }

  async function handleSystemShare() {
    if (!blob) return;
    try {
      const name = ensureFilenameForBlob(filename, blob);
      const ok = await tryWebShare({ blob, filename: name, boardUrl, message });
      if (ok) {
        onClose?.();
        return;
      }
      if (navigator.share) {
        await navigator.share({ title: 'Whiteboard', text: message, url: boardUrl });
        onClose?.();
        return;
      }
      alert('System share not supported on this device/browser.');
    } catch (e) {
      console.error('System share failed', e);
      alert('System share failed.');
    }
  }

  function handleDownload() {
    try {
      if (!blob) {
        alert('Still preparing the export. Please wait a moment…');
        return;
      }
      const name = ensureFilenameForBlob(filename, blob);
      downloadBlob(blob, name);
    } catch (e) {
      console.error('download failed', e);
      try {
        const url = URL.createObjectURL(blob);
        window.open(url, '_blank', 'noopener,noreferrer');
        setTimeout(() => URL.revokeObjectURL(url), 15000);
        alert('Download appears blocked. The image opened in a new tab — use Save Image.');
      } catch {
        alert('Download failed.');
      }
    }
  }

  async function handleCopyImage() {
    try {
      if (!blob) return;
      await copyBlobToClipboard(blob);
      alert('Image copied to clipboard.');
    } catch (e) {
      console.warn('Clipboard blocked, opening image in new tab', e);
      const url = URL.createObjectURL(blob);
      window.open(url, '_blank', 'noopener,noreferrer');
      setTimeout(() => URL.revokeObjectURL(url), 15000);
      alert('Clipboard not available. Image opened in a new tab.');
    }
  }

  async function handleCopyLink() {
    try {
      await copyText(boardUrl);
      alert('Link copied to clipboard.');
    } catch {
      alert('Copy failed.');
    }
  }

  function handlePrintPDF() {
    try {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const html = `
<!doctype html><meta charset="utf-8"/><title>Whiteboard Export</title>
<style>
@page { size:auto; margin:12mm; }
html,body{height:100%}
body{margin:0;display:grid;place-items:center;background:#fff}
img{max-width:100%;max-height:100vh}
</style>
<img src="${url}" onload="setTimeout(()=>window.print(), 300)"/>
`;
      const w = window.open('', '_blank', 'noopener,noreferrer');
      w.document.open();
      w.document.write(html);
      w.document.close();
      setTimeout(() => URL.revokeObjectURL(url), 15000);
    } catch (e) {
      console.error('print failed', e);
      alert('Print failed.');
    }
  }

  async function shareTo(network) {
    try {
      let shareUrl = boardUrl;

      if (uploadImage && blob) {
        setBusy(true);
        const uploaded = await maybeUploadToServer(
          new File([blob], ensureFilenameForBlob('whiteboard.png', blob), {
            type: blob.type || 'image/png',
          })
        );
        setBusy(false);
        if (uploaded) {
          const u = new URL(shareUrl, location.origin);
          const sp = u.searchParams;
          sp.set('img', uploaded);
          u.search = sp.toString();
          shareUrl = u.toString();
        }
      }

      const url = socialUrl(network, { url: shareUrl, text: message });
      popup(url);
    } catch (e) {
      console.error('social share failed', e);
      alert('Unable to open share window (popup blocked?). Please allow popups.');
    }
  }

  return (
    <div
      id="share-dialog"
      className="fixed inset-0 z-[60] grid place-items-center bg-black/40 backdrop-blur-sm"
    >
      <div className="w-[520px] max-w-[95vw] rounded-xl border bg-white dark:bg-zinc-900 shadow-xl">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b">
          <div className="font-semibold">Share whiteboard</div>
          <button
            type="button"
            className="text-sm opacity-70 hover:opacity-100"
            onClick={onClose}
          >
            ✕
          </button>
        </div>

        {/* Body */}
        <div className="p-4 space-y-4">
          {/* Formats */}
          <div className="grid grid-cols-4 gap-2">
            {FORMATS.map((f) => (
              <button
                key={f}
                type="button"
                onClick={() => setFormat(f)}
                className={`px-3 py-2 rounded border ${
                  format === f
                    ? 'bg-indigo-600 text-white border-indigo-600'
                    : 'hover:bg-black/5 dark:hover:bg-white/5'
                }`}
              >
                {f.toUpperCase()}
              </button>
            ))}
          </div>

          {/* Options */}
          <div className="grid grid-cols-2 gap-3 text-sm">
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={background}
                onChange={(e) => setBackground(e.target.checked)}
              />
              Include background
            </label>
            <label className="flex items-center gap-2">
              <span>Scale</span>
              <input
                type="number"
                min="1"
                max="4"
                value={scale}
                onChange={(e) =>
                  setScale(Math.max(1, Math.min(4, Number(e.target.value) || 2)))
                }
                className="input w-20"
              />
            </label>
            <label className="flex items-center gap-2 col-span-2">
              <input
                type="checkbox"
                checked={uploadImage}
                onChange={(e) => setUploadImage(e.target.checked)}
              />
              Upload image to server for social previews
            </label>
          </div>

          {/* Quick preview */}
          {!!blob && (
            <div className="rounded border p-2 bg-white dark:bg-zinc-800 grid place-items-center">
              <img
                alt="Export preview"
                src={URL.createObjectURL(blob)}
                className="max-h-[240px] object-contain"
                onLoad={(e) =>
                  setTimeout(() => URL.revokeObjectURL(e.currentTarget.src), 2000)
                }
              />
            </div>
          )}

          {/* Actions */}
          <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
            <button
              type="button"
              className="btn"
              onClick={handleSystemShare}
              disabled={busy || !blob || !canSystemShare}
            >
              System Share
            </button>
            <button
              type="button"
              className="btn"
              onClick={handleDownload}
              disabled={busy || !blob}
            >
              Download
            </button>
            <button
              type="button"
              className="btn"
              onClick={handleCopyImage}
              disabled={busy || !blob || !hasClipboardImage}
            >
              Copy Image
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => shareTo('whatsapp')}
              disabled={busy}
            >
              WhatsApp
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => shareTo('telegram')}
              disabled={busy}
            >
              Telegram
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => shareTo('twitter')}
              disabled={busy}
            >
              Twitter/X
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => shareTo('facebook')}
              disabled={busy}
            >
              Facebook
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => shareTo('linkedin')}
              disabled={busy}
            >
              LinkedIn
            </button>
            <button
              type="button"
              className="btn-outline"
              onClick={handleCopyLink}
              disabled={busy}
            >
              Copy Link
            </button>
            <button
              type="button"
              className="btn-outline"
              onClick={handlePrintPDF}
              disabled={busy || !blob}
            >
              Print → PDF
            </button>
          </div>

          {/* Hints / errors */}
          {!canSystemShare && (
            <div className="text-[11px] opacity-70">
              System Share not supported on this browser. Try Download or Copy Image instead.
            </div>
          )}
          {!hasClipboardImage && (
            <div className="text-[11px] opacity-70">
              Clipboard image API not available here. Use Download, then paste.
            </div>
          )}
          {error && <div className="text-sm text-rose-600">Error: {error}</div>}
          {busy && <div className="text-xs opacity-70">Preparing image…</div>}
        </div>
      </div>
    </div>
  );
}
