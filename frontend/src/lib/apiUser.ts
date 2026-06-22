// src/lib/apiUser.ts — 用户后端 API 层（独立于现有 api.ts/apiAuth.ts）
// 走 vite proxy /user-api → cool-admin :8001，裸 token 鉴权

import type { Captcha, LoginResult, UserInfo } from "@/types/user";

const BASE = import.meta.env.VITE_USER_API_BASE || "/user-api";

export class UserApiError extends Error {
  code?: number;
  status?: number;
  constructor(message: string, opts: { code?: number; status?: number } = {}) {
    super(message);
    this.name = "UserApiError";
    this.code = opts.code;
    this.status = opts.status;
  }
}

interface CoolResponse<T> {
  code: number;
  data: T;
  message?: string;
}

// === Token holder（由 auth store 同步写入，避免循环依赖） ===

let _token: string | null = null;
let _refreshToken: string | null = null;

/** auth store 在 setSession/logout 时同步调用，供 apiUser 读取。 */
export function setUserSessionTokens(token: string | null, refreshToken: string | null) {
  _token = token;
  _refreshToken = refreshToken;
}

function getToken() {
  return _token;
}

export function __getRefreshTokenForTest() {
  return _refreshToken;
}

// === 401 自动刷新（single-flight） ===

let _refreshPromise: Promise<void> | null = null;

async function doRefresh(): Promise<void> {
  const rt = _refreshToken;
  if (!rt) throw new UserApiError("未登录或登录已过期", { status: 401 });
  const result = await apiUser.refreshToken(rt); // skipAuthRefresh=true
  setUserSessionTokens(result.token, result.refreshToken);
}

/** 并发只刷新一次：所有 401 等同一个 promise。 */
function refreshOnce(): Promise<void> {
  if (!_refreshPromise) {
    _refreshPromise = doRefresh().finally(() => {
      _refreshPromise = null;
    });
  }
  return _refreshPromise;
}

// === 核心请求 ===

export interface RequestOptions extends RequestInit {
  /** 内部：跳过 401 自动刷新（refreshToken 自身使用）。 */
  skipAuthRefresh?: boolean;
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { skipAuthRefresh, headers, ...rest } = options;

  const res = await fetch(`${BASE}${path}`, {
    ...rest,
    headers: buildHeaders(headers),
  });

  if (res.status === 401 && !skipAuthRefresh) {
    await refreshOnce(); // 失败会抛，直接冒泡
    // 用新 token 重试一次，禁止再次刷新
    return request<T>(path, { ...options, skipAuthRefresh: true });
  }

  if (!res.ok) {
    throw new UserApiError(`HTTP ${res.status}`, { status: res.status });
  }
  const text = await res.text();
  const body: CoolResponse<T> = text ? JSON.parse(text) : ({ code: 1000, data: undefined as T });
  if (body.code !== 1000) {
    throw new UserApiError(body.message || `code=${body.code}`, { code: body.code });
  }
  return body.data;
}

function buildHeaders(extraHeaders?: HeadersInit): Record<string, string> {
  const merged: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (_token) merged["Authorization"] = _token; // 不带 Bearer
  if (extraHeaders) new Headers(extraHeaders).forEach((v, k) => (merged[k] = v));
  return merged;
}

// === 业务方法 ===

export const apiUser = {
  request,

  getCaptcha(opts: { width?: number; height?: number } = {}) {
    const q = new URLSearchParams();
    if (opts.width != null) q.set("width", String(opts.width));
    if (opts.height != null) q.set("height", String(opts.height));
    const qs = q.toString();
    return request<Captcha>(`/app/user/login/captcha${qs ? `?${qs}` : ""}`);
  },

  sendSmsCode(phone: string, captchaId: string, code: string) {
    return request<void>("/app/user/login/smsCode", {
      method: "POST",
      body: JSON.stringify({ phone, captchaId, code }),
    });
  },

  loginByPhone(phone: string, smsCode: string) {
    return request<LoginResult>("/app/user/login/phone", {
      method: "POST",
      body: JSON.stringify({ phone, smsCode }),
    });
  },

  refreshToken(refreshToken: string) {
    return request<LoginResult>("/app/user/login/refreshToken", {
      method: "POST",
      body: JSON.stringify({ refreshToken }),
      skipAuthRefresh: true,
    });
  },

  getPerson() {
    return request<UserInfo>("/app/user/info/person");
  },

  updatePerson(body: {
    nickName?: string;
    avatarUrl?: string;
    gender?: number;
    description?: string;
  }) {
    return request<UserInfo>("/app/user/info/updatePerson", {
      method: "POST",
      body: JSON.stringify(body),
    });
  },

  upload(file: File) {
    const form = new FormData();
    form.append("file", file);
    const headers: Record<string, string> = {};
    if (_token) headers["Authorization"] = _token;
    return fetch(`${BASE}/app/base/comm/upload`, {
      method: "POST",
      headers,
      body: form,
    }).then(async (res) => {
      const text = await res.text();
      const body: CoolResponse<{ url: string; [k: string]: unknown }> = text
        ? JSON.parse(text)
        : { code: 1000, data: { url: "" } };
      if (body.code !== 1000) {
        throw new UserApiError(body.message || `code=${body.code}`, { code: body.code });
      }
      return body.data;
    });
  },
};
