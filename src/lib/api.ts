// Same-origin API client. Auth rides on the httpOnly cookie (bolitas_session),
// so the browser attaches it automatically — no token handling here.

export class ApiError extends Error {
  status: number;
  code?: string;
  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const isForm = init?.body instanceof FormData;
  const res = await fetch(path, {
    ...init,
    headers: {
      ...(init?.body && !isForm ? { "Content-Type": "application/json" } : {}),
      ...init?.headers,
    },
  });

  const ct = res.headers.get("content-type") || "";
  const data = ct.includes("application/json") ? await res.json().catch(() => null) : null;

  if (res.status === 401) {
    // Expired/missing session on a protected route → bounce to login.
    // The login endpoint's own "wrong credentials" 401 carries a different code
    // and must surface to the form instead of redirecting.
    if (
      typeof window !== "undefined" &&
      !window.location.pathname.startsWith("/auth") &&
      (!data?.code || data.code === "NOT_AUTHENTICATED" || data.code === "SESSION_REVOKED")
    ) {
      window.location.href = "/auth/login";
    }
    throw new ApiError(
      data && typeof data.error === "string" ? data.error : "Não autenticado",
      401,
      data?.code
    );
  }

  if (!res.ok) {
    const message = (data && typeof data.error === "string") ? data.error : `Erro ${res.status}`;
    throw new ApiError(message, res.status, data?.code);
  }
  return data as T;
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown) =>
    request<T>(path, {
      method: "POST",
      body: body instanceof FormData ? body : JSON.stringify(body ?? {}),
    }),
  put: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: "PUT", body: JSON.stringify(body ?? {}) }),
  patch: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: "PATCH", body: JSON.stringify(body ?? {}) }),
  del: <T>(path: string, body?: unknown) =>
    request<T>(path, {
      method: "DELETE",
      body: body ? JSON.stringify(body) : undefined,
    }),
};
