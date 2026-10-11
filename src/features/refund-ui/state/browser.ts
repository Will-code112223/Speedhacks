"use client";

/**
 * Small browser hooks shared by the shell, the call screen and the metrics.
 * Each one is safe during server rendering and hydration.
 */

import { useEffect, useState, useSyncExternalStore } from "react";

/**
 * Current time in milliseconds, re-rendering on whole-second boundaries so
 * timers never skip or repeat a second. Pass enabled=false to freeze it.
 */
export function useNow(enabled = true, intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    let timer: number | undefined;
    const tick = () => {
      const current = Date.now();
      setNow(current);
      timer = window.setTimeout(tick, intervalMs - (current % intervalMs) + 5);
    };
    tick();
    return () => window.clearTimeout(timer);
  }, [enabled, intervalMs]);
  return now;
}

function subscribeToMedia(query: string) {
  return (onChange: () => void) => {
    if (typeof window === "undefined" || !window.matchMedia) return () => {};
    const list = window.matchMedia(query);
    list.addEventListener("change", onChange);
    return () => list.removeEventListener("change", onChange);
  };
}

const mediaSubscribers = new Map<string, (onChange: () => void) => () => void>();

/** Live result of a media query. The server and first hydration pass report false. */
export function useMediaQuery(query: string): boolean {
  let subscribe = mediaSubscribers.get(query);
  if (!subscribe) {
    subscribe = subscribeToMedia(query);
    mediaSubscribers.set(query, subscribe);
  }
  return useSyncExternalStore(
    subscribe,
    () => (typeof window !== "undefined" && window.matchMedia ? window.matchMedia(query).matches : false),
    () => false,
  );
}

export function usePrefersReducedMotion(): boolean {
  return useMediaQuery("(prefers-reduced-motion: reduce)");
}

/** Sets document.title while `title` is non-null and restores the previous title afterwards. */
export function useDocumentTitle(title: string | null): void {
  useEffect(() => {
    if (title === null) return;
    const previous = document.title;
    document.title = title;
    return () => {
      document.title = previous;
    };
  }, [title]);
}

const noopSubscribe = () => () => {};

/** window.location.search on the client, null on the server and during hydration. */
export function useLocationSearch(): string | null {
  return useSyncExternalStore(
    noopSubscribe,
    () => window.location.search,
    () => null,
  );
}
