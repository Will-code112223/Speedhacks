/**
 * The two rolling mechanics of the landing page, ported by hand from componentry.dev
 * ("Velocity Scroll" and "Text Morph") into plain React: no framer-motion, styles set per frame.
 */

import { type RefObject, useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";

const REDUCED_QUERY = "(prefers-reduced-motion: reduce)";

/** False on the server and the first client render, then the live media query. */
export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const query = window.matchMedia(REDUCED_QUERY);
    const update = () => setReduced(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return reduced;
}

/* Velocity Scroll ---------------------------------------------------------- */

/** Copies of the text in a band row; one copy is 100 / BAND_COPIES percent of the track. */
export const BAND_COPIES = 8;
const COPY_PERCENT = 100 / BAND_COPIES;
/** framer-motion's useSpring(scrollVelocity, { damping: 50, stiffness: 400 }), mass 1: overdamped, settles in about 400ms. */
const SPRING_STIFFNESS = 400;
const SPRING_DAMPING = 50;
const SPRING_STEP_MS = 4;

/** framer-motion's wrap(): keeps v inside [min, max) by whole ranges. */
export function wrap(min: number, max: number, v: number): number {
  const range = max - min;
  return ((((v - min) % range) + range) % range) + min;
}

/**
 * Rolls a band row's track on requestAnimationFrame at `baseVelocity` percent per second.
 * The page's scroll velocity, smoothed by a spring, multiplies the speed and flips the direction.
 */
export function useVelocityRow(trackRef: RefObject<HTMLElement | null>, baseVelocity: number, reduced: boolean): void {
  useEffect(() => {
    const track = trackRef.current;
    if (!track) return;
    if (reduced || window.matchMedia(REDUCED_QUERY).matches) {
      track.style.transform = "";
      return;
    }
    let baseX = 0;
    let direction = 1;
    let lastScroll = window.scrollY;
    let smooth = 0;
    let smoothSpeed = 0;
    let last: number | undefined;
    let frame = 0;

    const tick = (now: number) => {
      const delta = last === undefined ? 0 : Math.min(now - last, 100);
      last = now;
      if (delta > 0) {
        const seconds = delta / 1000;
        const scroll = window.scrollY;
        const rawVelocity = (scroll - lastScroll) / seconds;
        lastScroll = scroll;
        const steps = Math.ceil(delta / SPRING_STEP_MS);
        const h = seconds / steps;
        for (let i = 0; i < steps; i += 1) {
          smoothSpeed += (SPRING_STIFFNESS * (rawVelocity - smooth) - SPRING_DAMPING * smoothSpeed) * h;
          smooth += smoothSpeed * h;
        }
        // useTransform(smoothVelocity, [0, 1000], [0, 5], { clamp: false })
        const velocityFactor = (smooth / 1000) * 5;
        if (velocityFactor < 0) direction = -1;
        else if (velocityFactor > 0) direction = 1;
        let moveBy = direction * baseVelocity * seconds;
        moveBy += direction * moveBy * velocityFactor;
        baseX += moveBy;
        track.style.transform = `translate3d(${wrap(-COPY_PERCENT, 0, baseX).toFixed(4)}%, 0, 0)`;
      }
      frame = window.requestAnimationFrame(tick);
    };

    frame = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(frame);
  }, [trackRef, baseVelocity, reduced]);
}

/* Text Morph --------------------------------------------------------------- */

const MORPH_BLUR = 12;
const MORPH_THRESHOLD = 18;
const MORPH_EASE = "cubic-bezier(0.22, 1, 0.36, 1)";
/** Alpha threshold: alpha' = 18a - 8.28, so blurred overlapping layers fuse into one fluid shape. */
export const THRESHOLD_MATRIX = `1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 ${MORPH_THRESHOLD} ${-MORPH_THRESHOLD * 0.46}`;

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));
const smoothstep = (value: number) => {
  const t = clamp01(value);
  return t * t * (3 - 2 * t);
};

function setLayer(element: HTMLElement, opacity: number, blur: number, scale: number) {
  element.style.opacity = opacity.toFixed(4);
  element.style.filter = blur > 0.01 ? `blur(${blur.toFixed(2)}px)` : "none";
  element.style.transform = `scale(${scale.toFixed(4)})`;
}

export interface TextMorph {
  stageRef: RefObject<HTMLSpanElement | null>;
  currentRef: RefObject<HTMLSpanElement | null>;
  nextRef: RefObject<HTMLSpanElement | null>;
  current: string;
  next: string;
  filterId: string;
}

/**
 * Cycles `words`: each rests for `interval`, then two stacked layers blur and crossfade through the
 * threshold filter while the stage's width and height transition to the next word.
 * Under reduced motion the first word stays put.
 */
export function useTextMorph(words: readonly string[], reduced: boolean, interval = 2600, morphDuration = 680): TextMorph {
  const [index, setIndex] = useState(0);
  const stageRef = useRef<HTMLSpanElement>(null);
  const currentRef = useRef<HTMLSpanElement>(null);
  const nextRef = useRef<HTMLSpanElement>(null);
  const morphingRef = useRef(false);
  const frameRef = useRef<number | undefined>(undefined);
  const filterId = `landing-morph-${useId().replace(/[^\w-]/g, "")}`;
  const current = words[index % words.length] ?? "";
  const nextIndex = (index + 1) % words.length;
  const next = words[nextIndex] ?? "";

  const measure = useCallback((target: "current" | "next", immediate: boolean) => {
    const stage = stageRef.current;
    const layer = target === "current" ? currentRef.current : nextRef.current;
    if (!stage || !layer) return;
    // offsetWidth and offsetHeight ignore transforms, so both layers measure at rest.
    const width = `${layer.offsetWidth}px`;
    const height = `${layer.offsetHeight}px`;
    if (!immediate) {
      stage.style.width = width;
      stage.style.height = height;
      return;
    }
    const transition = stage.style.transition;
    stage.style.transition = "none";
    stage.style.width = width;
    stage.style.height = height;
    void stage.offsetWidth;
    stage.style.transition = transition;
  }, []);

  useLayoutEffect(() => {
    const stage = stageRef.current;
    const currentLayer = currentRef.current;
    const nextLayer = nextRef.current;
    if (!stage || !currentLayer || !nextLayer) return;
    setLayer(currentLayer, 1, 0, 1);
    setLayer(nextLayer, 0, MORPH_BLUR, 0.992);
    currentLayer.style.willChange = "auto";
    nextLayer.style.willChange = "auto";
    stage.style.filter = "none";
    stage.style.transition = reduced ? "none" : `width ${morphDuration}ms ${MORPH_EASE}, height ${morphDuration}ms ${MORPH_EASE}`;
    measure("current", true);
  }, [index, measure, morphDuration, reduced]);

  useEffect(() => {
    const currentLayer = currentRef.current;
    const nextLayer = nextRef.current;
    if (!currentLayer || !nextLayer) return;
    const observer = new ResizeObserver(() => {
      if (!morphingRef.current) measure("current", true);
    });
    observer.observe(currentLayer);
    observer.observe(nextLayer);
    return () => observer.disconnect();
  }, [measure]);

  const beginMorph = useCallback(() => {
    const stage = stageRef.current;
    const currentLayer = currentRef.current;
    const nextLayer = nextRef.current;
    if (!stage || !currentLayer || !nextLayer || morphingRef.current) return;
    morphingRef.current = true;
    currentLayer.style.willChange = "opacity, filter, transform";
    nextLayer.style.willChange = "opacity, filter, transform";
    stage.style.filter = `url(#${filterId})`;
    measure("next", false);
    const startedAt = performance.now();

    const renderFrame = (now: number) => {
      const progress = clamp01((now - startedAt) / morphDuration);
      // The incoming layer starts early and the outgoing one lingers; the overlap gives the
      // threshold filter enough shared alpha to read as one shape changing.
      const incoming = smoothstep(progress / 0.82);
      const outgoing = smoothstep((progress - 0.18) / 0.82);
      setLayer(currentLayer, Math.pow(1 - outgoing, 0.55), MORPH_BLUR * outgoing, 1 - outgoing * 0.012);
      setLayer(nextLayer, Math.pow(incoming, 0.55), MORPH_BLUR * (1 - incoming), 0.988 + incoming * 0.012);
      if (progress < 1) {
        frameRef.current = window.requestAnimationFrame(renderFrame);
        return;
      }
      stage.style.filter = "none";
      morphingRef.current = false;
      setIndex(nextIndex);
    };
    frameRef.current = window.requestAnimationFrame(renderFrame);
  }, [filterId, measure, morphDuration, nextIndex]);

  useEffect(() => {
    if (reduced || words.length < 2) return;
    const timer = window.setTimeout(beginMorph, interval);
    return () => window.clearTimeout(timer);
  }, [beginMorph, index, interval, reduced, words.length]);

  useEffect(
    () => () => {
      if (frameRef.current !== undefined) window.cancelAnimationFrame(frameRef.current);
    },
    [],
  );

  return { stageRef, currentRef, nextRef, current, next, filterId };
}
