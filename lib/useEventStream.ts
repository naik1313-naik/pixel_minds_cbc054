"use client";

import { useEffect, useRef } from "react";

// Subscribes to a Server-Sent Events endpoint and invokes onEvent for each message.
export function useEventStream<T = unknown>(url: string | null, onEvent: (data: T) => void) {
  const handler = useRef(onEvent);
  handler.current = onEvent;
  useEffect(() => {
    if (!url) return;
    const es = new EventSource(url);
    es.onmessage = (e) => {
      try {
        handler.current(JSON.parse(e.data) as T);
      } catch {
        /* ignore malformed */
      }
    };
    es.onerror = () => {
      /* browser will retry automatically */
    };
    return () => es.close();
  }, [url]);
}
