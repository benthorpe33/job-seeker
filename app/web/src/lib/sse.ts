import { useEffect, useRef } from "react";

export function useSSE(
  url: string | null,
  onEvent: (event: MessageEvent) => void,
  eventName: string = "message",
): void {
  const handlerRef = useRef(onEvent);
  handlerRef.current = onEvent;

  useEffect(() => {
    if (!url) return;
    const es = new EventSource(url);
    const fwd = (e: MessageEvent) => handlerRef.current(e);
    es.addEventListener(eventName, fwd as EventListener);
    if (eventName !== "message") {
      es.addEventListener("message", fwd as EventListener);
    }
    es.onerror = () => {
      // EventSource auto-reconnects; nothing to do here unless we want backoff.
    };
    return () => {
      es.removeEventListener(eventName, fwd as EventListener);
      if (eventName !== "message") {
        es.removeEventListener("message", fwd as EventListener);
      }
      es.close();
    };
  }, [url, eventName]);
}
