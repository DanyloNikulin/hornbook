import { Injectable } from '@angular/core';
import type { ViewportScroller } from '@angular/common';

/** The element that scrolls the page: everything below the navigation. */
export const SCROLL_CONTAINER = '.il-scroll';

/**
 * Router scrolling against the app's own scroll container instead of the
 * window. The navigation and the desktop title strip stay put above it, so
 * the scrollbar starts under them and anchors need only a small margin.
 * Without the container (tests, a bare template) the window is used.
 */
@Injectable()
export class ContainerViewportScroller implements ViewportScroller {
  private offset: () => [number, number] = () => [0, 0];

  setOffset(offset: [number, number] | (() => [number, number])): void {
    this.offset = Array.isArray(offset) ? () => offset : offset;
  }

  getScrollPosition(): [number, number] {
    const container = this.container();
    return container ? [container.scrollLeft, container.scrollTop] : [window.scrollX, window.scrollY];
  }

  scrollToPosition(position: [number, number], options?: ScrollOptions): void {
    const container = this.container();
    if (container) container.scrollTo({ left: position[0], top: position[1], ...options });
    else window.scrollTo({ left: position[0], top: position[1], ...options });
  }

  scrollToAnchor(anchor: string, options?: ScrollOptions): void {
    const target = this.anchorElement(anchor);
    if (!target) return;
    const [offsetX, offsetY] = this.offset();
    const container = this.container();
    if (!container) {
      const rect = target.getBoundingClientRect();
      window.scrollTo({ left: rect.left + window.scrollX - offsetX, top: rect.top + window.scrollY - offsetY, ...options });
      return;
    }
    const rect = target.getBoundingClientRect();
    const box = container.getBoundingClientRect();
    container.scrollTo({
      left: rect.left - box.left + container.scrollLeft - offsetX,
      top: rect.top - box.top + container.scrollTop - offsetY,
      ...options,
    });
  }

  setHistoryScrollRestoration(scrollRestoration: 'auto' | 'manual'): void {
    try {
      history.scrollRestoration = scrollRestoration;
    } catch {
      // Not every environment exposes history.scrollRestoration.
    }
  }

  private container(): HTMLElement | null {
    return typeof document === 'undefined' ? null : document.querySelector<HTMLElement>(SCROLL_CONTAINER);
  }

  private anchorElement(anchor: string): Element | null {
    if (typeof document === 'undefined') return null;
    return document.getElementById(anchor) ?? document.querySelector(`[name="${CSS.escape(anchor)}"]`);
  }
}
