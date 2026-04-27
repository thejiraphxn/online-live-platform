import type { CourseRole } from './enums';

const BASE = process.env.NEXT_PUBLIC_API_BASE ?? 'http://localhost:4000/api/v1';

type ApiInit = Omit<RequestInit, 'body'> & {
  // Allow any JSON-serializable body; our helper stringifies for you.
  body?: unknown;
};

export async function api<T = any>(path: string, init: ApiInit = {}): Promise<T> {
  const { body, headers, ...rest } = init;
  const payload =
    body === undefined || body === null
      ? undefined
      : typeof body === 'string' || body instanceof FormData || body instanceof Blob
        ? (body as BodyInit)
        : JSON.stringify(body);
  const res = await fetch(`${BASE}${path}`, {
    ...rest,
    credentials: 'include',
    headers: {
      // Only set JSON content-type when we're actually sending JSON.
      ...(payload && typeof payload === 'string' ? { 'Content-Type': 'application/json' } : {}),
      ...(headers ?? {}),
    },
    body: payload,
  });
  if (!res.ok) {
    const err: any = new Error(`API ${res.status}`);
    err.status = res.status;
    err.body = await res.json().catch(() => ({}));
    throw err;
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

export type Me = {
  id: string;
  email: string;
  name: string;
  memberships: {
    courseId: string;
    role: CourseRole;
    course: { id: string; code: string; title: string };
  }[];
};

export type Paginated<T> = {
  items: T[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
};

export function qs(params: Record<string, string | number | undefined | null>) {
  const clean = Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '');
  if (clean.length === 0) return '';
  return '?' + new URLSearchParams(clean.map(([k, v]) => [k, String(v)])).toString();
}
