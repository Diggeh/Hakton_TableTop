import { useEffect, useState } from 'react';

/**
 * Loads an image element for Konva without relying on extra dependencies.
 * Displaying a cross-origin image is fine; only canvas export would taint it.
 */
export function useCanvasImage(url) {
  const [image, setImage] = useState(null);
  const [status, setStatus] = useState(url ? 'loading' : 'idle');

  useEffect(() => {
    if (!url) {
      setImage(null);
      setStatus('idle');
      return undefined;
    }

    let cancelled = false;
    const element = new window.Image();
    element.decoding = 'async';
    element.onload = () => {
      if (cancelled) return;
      setImage(element);
      setStatus('loaded');
    };
    element.onerror = () => {
      if (cancelled) return;
      setImage(null);
      setStatus('error');
    };
    setStatus('loading');
    element.src = url;

    return () => {
      cancelled = true;
      element.onload = null;
      element.onerror = null;
    };
  }, [url]);

  return { image, status };
}
