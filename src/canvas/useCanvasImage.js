import { useEffect, useState } from 'react';
import { getSocket } from '../net/socket.js';
import { isWebRtcUrl, resolveWebRtcAssetBlobUrl } from '../net/webrtcAssets.js';

/**
 * Loads an image element for Konva without relying on extra dependencies.
 * Supports both HTTP(S)/data/blob URLs and chunked `webrtc://` P2P asset URLs.
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

    if (isWebRtcUrl(url)) {
      resolveWebRtcAssetBlobUrl(url, getSocket())
        .then((blobUrl) => {
          if (cancelled) return;
          if (!blobUrl) {
            setImage(null);
            setStatus('error');
            return;
          }
          element.src = blobUrl;
        })
        .catch(() => {
          if (cancelled) return;
          setImage(null);
          setStatus('error');
        });
    } else {
      element.src = url;
    }

    return () => {
      cancelled = true;
      element.onload = null;
      element.onerror = null;
    };
  }, [url]);

  return { image, status };
}
