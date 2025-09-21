import { useEffect, useState } from 'react';

/**
 * Computes how far (in pixels) the FAB should be lifted so it never overlaps the chat/voice panels.
 * - Measures DOM rects live with ResizeObserver
 * - Accounts for iOS safe area
 */
export function useFabAutoOffset({ chatOpen, voiceOpen, gap = 16, base = 20 }) {
  const [offsetPx, setOffsetPx] = useState(base);

  useEffect(() => {
    const chat = chatOpen ? document.getElementById('chat-panel') : null;
    const voice = voiceOpen ? document.getElementById('voice-panel') : null;

    const calc = () => {
      const safeStr = getComputedStyle(document.documentElement).getPropertyValue('--sat-bottom') || '0px';
      const safePx = Number.parseInt(safeStr) || 0;

      const needAbove = (el) => {
        if (!el) return 0;
        const r = el.getBoundingClientRect();
        // distance from bottom of viewport to top of panel + gap
        const need = Math.max(0, (window.innerHeight - r.top) + gap);
        return need;
      };

      const needed = Math.max(needAbove(chat), needAbove(voice), base) + safePx;
      setOffsetPx(needed);
    };

    const ros = [];
    const watch = (el) => {
      if (!el) return;
      const ro = new ResizeObserver(calc);
      ro.observe(el);
      ros.push(ro);
    };

    calc();
    watch(chat);
    watch(voice);

    window.addEventListener('resize', calc);
    window.addEventListener('scroll', calc, true);

    return () => {
      ros.forEach((ro) => ro.disconnect());
      window.removeEventListener('resize', calc);
      window.removeEventListener('scroll', calc, true);
    };
  }, [chatOpen, voiceOpen, gap, base]);

  return offsetPx;
}
