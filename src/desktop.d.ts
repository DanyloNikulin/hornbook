import type { HornbookDesktopBridge } from './lib/desktop';

declare global {
  interface Window {
    hornbookDesktop?: HornbookDesktopBridge;
  }
}

export {};
