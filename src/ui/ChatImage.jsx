import { useEffect, useRef, useState } from 'react';
import { fetchChatImage } from '../net/chat.js';

export default function ChatImage({ message, connected, visible }) {
  const placeholder = useRef(null);
  const [inView, setInView] = useState(false);
  const [image, setImage] = useState(null);
  const [error, setError] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!visible || !placeholder.current) return;
    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) {
        setInView(true);
        observer.disconnect();
      }
    });
    observer.observe(placeholder.current);
    return () => observer.disconnect();
  }, [visible]);

  useEffect(() => {
    if (!inView || !visible || !connected || message.status !== 'sent' || image)
      return;
    let active = true;
    setError(false);
    fetchChatImage(message.id).then(
      (data) => {
        if (active) setImage(data);
      },
      () => {
        if (active) setError(true);
      },
    );
    return () => {
      active = false;
    };
  }, [message.id, message.status, inView, visible, connected, attempt, image]);

  const data = message.image || image;
  return (
    <div ref={placeholder} className="chat-attachment">
      {data && !error ? (
        <img
          src={`data:image/webp;base64,${data}`}
          alt="Shared image"
          loading="lazy"
          onError={() => setError(true)}
        />
      ) : error ? (
        <button
          type="button"
          disabled={!connected || message.status !== 'sent'}
          onClick={() => {
            setImage(null);
            setAttempt((n) => n + 1);
          }}
        >
          Retry image
        </button>
      ) : (
        <small>
          {connected ? 'Loading image…' : 'Reconnect to load image'}
        </small>
      )}
    </div>
  );
}
