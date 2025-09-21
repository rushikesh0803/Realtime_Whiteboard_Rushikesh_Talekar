// src/lib/share.js

function log(...args) {
  console.debug('[share]', ...args);
}

const isIOS =
  typeof navigator !== 'undefined' && /iP(ad|hone|od)/i.test(navigator.userAgent);
const isSafari =
  typeof navigator !== 'undefined' &&
  /^((?!chrome|android).)*safari/i.test(navigator.userAgent);

/**
 * Robust raster export only (PNG/JPG/WEBP).
 * For "pdf" we still export PNG and let the UI print it.
 */
export async function exportBlob({
  editor,
  format = 'png',     // 'png' | 'jpg' | 'jpeg' | 'webp' | 'pdf' (raster)
  scale = 2,
  background = true,
}) {
  if (!editor) throw new Error('TLDraw editor not ready');

  // Normalize format (no SVG in this build)
  let fmt = String(format).toLowerCase();
  if (fmt === 'pdf') fmt = 'png'; // produce PNG; UI prints it
  if (fmt === 'jpeg') fmt = 'jpg';

  try {
    const mod = await import('@tldraw/tldraw');
    if (!mod.exportToBlob) {
      throw new Error('This version of @tldraw/tldraw does not support exportToBlob');
    }

    const blob = await mod.exportToBlob({ editor, format: fmt, scale, background });
    if (!(blob instanceof Blob)) throw new Error('exportToBlob returned non-Blob');

    log('exported raster', { format: fmt, scale, background, size: blob.size });
    return blob;
  } catch (e) {
    // Fallback to PNG if requested format failed
    if (fmt !== 'png') {
      console.warn('[share] export failed for', fmt, '— falling back to PNG', e);
      const mod = await import('@tldraw/tldraw');
      const blob = await mod.exportToBlob({ editor, format: 'png', scale, background });
      if (!(blob instanceof Blob)) throw new Error('exportToBlob returned non-Blob (fallback)');
      log('exported fallback PNG', { scale, background, size: blob.size });
      return blob;
    }
    throw e;
  }
}

/**
 * Cross-browser download (includes Safari/iOS fallbacks).
 */
export function downloadBlob(blob, filename = 'whiteboard.png') {
  if (!(blob instanceof Blob)) {
    console.error('[downloadBlob] not a Blob', blob);
    throw new Error('No blob to download');
  }

  // Old Edge / IE
  if (typeof window.navigator !== 'undefined' && window.navigator.msSaveOrOpenBlob) {
    try {
      window.navigator.msSaveOrOpenBlob(blob, filename);
      log('msSaveOrOpenBlob success', filename, blob.size);
      return;
    } catch (e) {
      log('msSaveOrOpenBlob failed, fallback', e);
    }
  }

  const url = URL.createObjectURL(blob);

  // iOS & Safari: a.download is ignored for blob: URLs
  if (isIOS || isSafari) {
    const w = window.open(url, '_blank', 'noopener,noreferrer');
    if (!w) {
      // popup blocked → try hidden iframe
      const iframe = document.createElement('iframe');
      iframe.style.display = 'none';
      iframe.src = url;
      document.body.appendChild(iframe);
      setTimeout(() => {
        document.body.removeChild(iframe);
        URL.revokeObjectURL(url);
      }, 15000);
    } else {
      setTimeout(() => URL.revokeObjectURL(url), 15000);
    }
    alert('Your browser opened the image in a new tab. Use “Save Image” to download.');
    log('opened for download (Safari/iOS fallback)', filename, blob.size);
    return;
  }

  // Standard modern path
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener noreferrer';
  a.style.display = 'none';
  document.body.appendChild(a);

  const clickEvt = new MouseEvent('click', { bubbles: true, cancelable: true, view: window });
  a.dispatchEvent(clickEvt);

  setTimeout(() => {
    a.remove();
    URL.revokeObjectURL(url);
  }, 2000);

  log('downloaded', filename, blob.size);
}

export async function copyBlobToClipboard(blob) {
  if (!blob) throw new Error('No blob to copy');
  if (!('ClipboardItem' in window) || !navigator.clipboard?.write) {
    throw new Error('Clipboard API not available');
  }
  const type = blob.type || 'image/png';
  const item = new ClipboardItem({ [type]: blob });
  await navigator.clipboard.write([item]);
  log('copied image to clipboard', blob.size);
}

export async function copyText(text) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
  } else {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  log('copied text', text);
}

export function socialUrl(network, { url, text = '' }) {
  const u = encodeURIComponent(url);
  const t = encodeURIComponent(text);
  switch (network) {
    case 'whatsapp': return `https://wa.me/?text=${t}%20${u}`;
    case 'telegram': return `https://t.me/share/url?url=${u}&text=${t}`;
    case 'twitter':  return `https://twitter.com/intent/tweet?url=${u}&text=${t}`;
    case 'facebook': return `https://www.facebook.com/sharer/sharer.php?u=${u}`;
    case 'linkedin': return `https://www.linkedin.com/sharing/share-offsite/?url=${u}`;
    default: return url;
  }
}

export function popup(url, { w = 640, h = 640 } = {}) {
  const y = (window.top?.outerHeight ?? window.innerHeight) / 2 + (window.top?.screenY ?? 0) - (h / 2);
  const x = (window.top?.outerWidth ?? window.innerWidth) / 2 + (window.top?.screenX ?? 0) - (w / 2);
  window.open(url, '_blank', `popup=yes,width=${w},height=${h},left=${x},top=${y},noopener,noreferrer`);
  log('popup', url);
}

export async function maybeUploadToServer(file) {
  try {
    const fd = new FormData();
    fd.append('file', file, file.name);
    const r = await fetch('/api/upload', { method: 'POST', body: fd, credentials: 'include' });
    if (!r.ok) return null;
    const j = await r.json();
    const abs = new URL(j.url, location.origin).toString();
    log('uploaded', abs);
    return abs;
  } catch (e) {
    log('upload failed', e);
    return null;
  }
}

/**
 * Tries native Web Share with attached file; falls back to URL+text if files not supported.
 * Returns true if any system share opened, false otherwise.
 */
export async function tryWebShare({ blob, filename = 'whiteboard.png', boardUrl, message = '' }) {
  try {
    if (!navigator.share) return false;

    // Prefer file share if possible
    if (navigator.canShare && blob) {
      try {
        const file = new File([blob], filename, { type: blob?.type || 'image/png' });
        const dataWithFile = {
          title: 'Whiteboard',
          text: message ? `${message}\n${boardUrl}` : boardUrl,
          files: [file],
        };
        if (!navigator.canShare(dataWithFile)) {
          // No files: share URL + text
          await navigator.share({ title: 'Whiteboard', text: message, url: boardUrl });
          log('system share success (no file)');
          return true;
        }
        await navigator.share(dataWithFile);
        log('system share success (with file)');
        return true;
      } catch (e) {
        log('file share failed, trying URL-only', e);
        await navigator.share({ title: 'Whiteboard', text: message, url: boardUrl });
        return true;
      }
    }

    // No canShare: URL+text only
    await navigator.share({ title: 'Whiteboard', text: message, url: boardUrl });
    return true;
  } catch (e) {
    log('system share declined/failed', e);
    return false;
  }
}
