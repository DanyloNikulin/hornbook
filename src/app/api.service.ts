import { Injectable } from '@angular/core';

/** Error from the Hornbook API: HTTP status plus the server's message. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly details?: unknown,
  ) {
    super(`HTTP ${status}: ${message}`);
  }
}

/**
 * The only way the UI talks to the journal. Same origin in production (the
 * server serves the UI); in development ng serve proxies /api to the server.
 */
@Injectable({ providedIn: 'root' })
export class ApiService {
  async get<T>(path: string, signal?: AbortSignal): Promise<T> {
    return this.request<T>('GET', path, undefined, signal);
  }

  async post<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
    return this.request<T>('POST', path, body, signal);
  }

  async put<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>('PUT', path, body);
  }

  async patch<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>('PATCH', path, body);
  }

  async delete<T>(path: string): Promise<T> {
    return this.request<T>('DELETE', path);
  }

  async download(path: string): Promise<{ blob: Blob; filename: string | null }> {
    const res = await fetch(path, { headers: { Accept: 'application/octet-stream' } });
    await this.assertOk(res);
    const disposition = res.headers.get('Content-Disposition') ?? '';
    const filename = /filename="([^"]+)"/.exec(disposition)?.[1] ?? null;
    return { blob: await res.blob(), filename };
  }

  private async request<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    const init: RequestInit = { method, headers: { Accept: 'application/json' }, signal };
    if (body !== undefined) {
      init.headers = { ...init.headers, 'Content-Type': 'application/json' };
      init.body = JSON.stringify(body);
    }
    const res = await fetch(path, init);
    await this.assertOk(res);
    return (await res.json()) as T;
  }

  private async assertOk(res: Response): Promise<void> {
    if (res.ok) return;
    let message = res.statusText || 'request failed';
    let details: unknown;
    try {
      const payload = (await res.json()) as { error?: string; details?: unknown };
      if (payload.error) message = payload.error;
      details = payload.details;
    } catch {
      // non-JSON error body
    }
    throw new ApiError(res.status, message, details);
  }
}

export function saveBrowserDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}
