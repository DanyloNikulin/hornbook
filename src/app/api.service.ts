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
  async get<T>(path: string): Promise<T> {
    return this.request<T>('GET', path);
  }

  async post<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>('POST', path, body);
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

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const init: RequestInit = { method, headers: { Accept: 'application/json' } };
    if (body !== undefined) {
      init.headers = { ...init.headers, 'Content-Type': 'application/json' };
      init.body = JSON.stringify(body);
    }
    const res = await fetch(path, init);
    if (!res.ok) {
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
    return (await res.json()) as T;
  }
}
