// src/types/user.ts — 用户相关 TS 类型（独立于现有 trading 类型）

export interface UserInfo {
  id: number;
  unionid?: string | null;
  avatarUrl?: string | null;
  nickName?: string | null;
  phone?: string | null;
  /** 0 未知 / 1 男 / 2 女 */
  gender: number;
  /** 0 禁用 / 1 正常 / 2 已注销 */
  status: number;
  /** 0 小程序 / 1 公众号 / 2 H5 */
  loginType: number;
  description?: string | null;
  createTime?: string;
  updateTime?: string;
}

export interface LoginResult {
  token: string;
  refreshToken: string;
  expire: number; // 秒
  refreshExpire: number; // 秒
}

export interface Captcha {
  captchaId: string;
  data: string; // base64 svg（可能含 data URI 前缀）
}

export type Gender = 0 | 1 | 2;
