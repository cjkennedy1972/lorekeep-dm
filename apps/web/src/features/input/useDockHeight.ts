import { useLayoutEffect, type RefObject } from 'react';

/**
 * Publishes the sticky composer's rendered height as `--dock-height` on the document root, so
 * scroll targets (focus, scroll-into-view, the story's auto-scroll) land above it. The composer's
 * height changes with pending and failure notices, so it is measured rather than fixed.
 */
export function useDockHeight(ref: RefObject<HTMLElement | null>) {
  // No dependency list: the composer mounts only once the room has loaded, so re-check each render.
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const root = document.documentElement;
    const publish = () =>
      root.style.setProperty('--dock-height', `${element.offsetHeight}px`);
    publish();
    if (typeof ResizeObserver === 'undefined')
      return () => root.style.removeProperty('--dock-height');
    const observer = new ResizeObserver(publish);
    observer.observe(element);
    return () => {
      observer.disconnect();
      root.style.removeProperty('--dock-height');
    };
  });
}
