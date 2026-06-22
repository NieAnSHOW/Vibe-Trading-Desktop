// src/lib/__tests__/apiUser.test.ts
import { apiUser, UserApiError, setUserSessionTokens, __getRefreshTokenForTest } from "../apiUser";

const json = (code: number, data: unknown, message = "") => ({
  status: 200,
  ok: true,
  headers: new Headers({ "content-type": "application/json" }),
  text: () => Promise.resolve(JSON.stringify({ code, data, message })),
});

beforeEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
  setUserSessionTokens(null, null);
});

// === Task 2: response unwrap ===

describe("apiUser request — response unwrap", () => {
  it("returns data when code === 1000", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(json(1000, { token: "t1" }) as any);
    const r = await (apiUser as any).request<{ token: string }>("/x");
    expect(r).toEqual({ token: "t1" });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("throws UserApiError with message when code !== 1000", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      json(1001, null, "图形验证码错误") as any
    );
    await expect((apiUser as any).request("/x")).rejects.toThrow(UserApiError);
    await expect((apiUser as any).request("/x")).rejects.toThrow("图形验证码错误");
  });

  it("throws on non-ok HTTP", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      status: 500,
      ok: false,
      headers: new Headers(),
      text: () => Promise.resolve(""),
    } as any);
    await expect((apiUser as any).request("/x")).rejects.toThrow();
  });
});

// === Task 3: token header ===

describe("apiUser — token header", () => {
  it("does not send Authorization when no token", async () => {
    setUserSessionTokens(null, null);
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(json(1000, {}) as any);
    await (apiUser as any).request("/x");
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  it("sends bare token (no Bearer) when token set", async () => {
    setUserSessionTokens("tok-1", "rt-1");
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(json(1000, {}) as any);
    await (apiUser as any).request("/x");
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBe("tok-1");
  });
});

// === Task 3: business methods ===

describe("apiUser — methods", () => {
  beforeEach(() => setUserSessionTokens(null, null));

  it("loginByPhone posts phone+smsCode and returns LoginResult", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(json(1000, { token: "T", refreshToken: "R", expire: 1, refreshExpire: 2 }) as any);
    const r = await apiUser.loginByPhone("13800000000", "1234");
    expect(r.token).toBe("T");
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/app/user/login/phone");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ phone: "13800000000", smsCode: "1234" });
  });

  it("getPerson GETs /app/user/info/person", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(json(1000, { id: 9, gender: 1, status: 1, loginType: 2 }) as any);
    const r = await apiUser.getPerson();
    expect(r.id).toBe(9);
    expect(fetchMock.mock.calls[0][0]).toContain("/app/user/info/person");
  });

  it("updatePerson posts patch and returns updated user", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(json(1000, { id: 9, nickName: "n", gender: 1, status: 1, loginType: 2 }) as any);
    const r = await apiUser.updatePerson({ nickName: "n" });
    expect(r.nickName).toBe("n");
    expect(JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)).toEqual({ nickName: "n" });
  });

  it("getCaptcha returns {captchaId,data}", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(json(1000, { captchaId: "c1", data: "<svg/>" }) as any);
    const r = await apiUser.getCaptcha();
    expect(r.captchaId).toBe("c1");
  });

  it("sendSmsCode posts phone+captchaId+code", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(json(1000, null) as any);
    await apiUser.sendSmsCode("13800000000", "cid", "9a8b");
    expect(JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)).toEqual({
      phone: "13800000000", captchaId: "cid", code: "9a8b",
    });
  });
});

// === Task 4: 401 refresh + retry ===

function unauthorized() {
  return {
    status: 401,
    ok: false,
    headers: new Headers(),
    text: () => Promise.resolve(JSON.stringify({ code: 401, message: "token expired" })),
  };
}

describe("apiUser — 401 refresh + retry", () => {
  beforeEach(() => setUserSessionTokens("old-tok", "old-rt"));

  it("refreshes token on 401 and retries the original request once", async () => {
    const fetchMock = vi.fn();
    // call 0: original 401 ; call 1: refreshToken 200 ; call 2: original retry 200
    fetchMock
      .mockResolvedValueOnce(unauthorized() as any)
      .mockResolvedValueOnce(json(1000, { token: "new-tok", refreshToken: "new-rt", expire: 1, refreshExpire: 2 }) as any)
      .mockResolvedValueOnce(json(1000, { ok: true }) as any);
    vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock as any);

    const r = await (apiUser as any).request<{ ok: boolean }>("/secure");
    expect(r).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    // retry used new token
    const retryInit = fetchMock.mock.calls[2][1] as RequestInit;
    expect((retryInit.headers as Record<string, string>).Authorization).toBe("new-tok");
    // token + refreshToken updated for apiUser
    expect(__getRefreshTokenForTest()).toBe("new-rt");
  });

  it("coalesces concurrent 401s into a single refresh", async () => {
    const fetchMock = vi.fn();
    fetchMock
      // two originals 401
      .mockResolvedValueOnce(unauthorized() as any)
      .mockResolvedValueOnce(unauthorized() as any)
      // ONE refresh
      .mockResolvedValueOnce(json(1000, { token: "T2", refreshToken: "R2", expire: 1, refreshExpire: 1 }) as any)
      // two retries succeed
      .mockResolvedValueOnce(json(1000, { n: 1 }) as any)
      .mockResolvedValueOnce(json(1000, { n: 2 }) as any);
    vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock as any);

    const [a, b] = await Promise.all([
      (apiUser as any).request<{ n: number }>("/a"),
      (apiUser as any).request<{ n: number }>("/b"),
    ]);
    expect(a.n).toBe(1);
    expect(b.n).toBe(2);
    // 2 originals + 1 refresh + 2 retries = 5
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it("throws when refresh itself fails", async () => {
    const fetchMock = vi.fn();
    fetchMock
      .mockResolvedValueOnce(unauthorized() as any)
      .mockResolvedValueOnce(json(1002, null, "refresh invalid") as any);
    vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock as any);

    await expect((apiUser as any).request("/secure")).rejects.toThrow();
  });
});

// === Task 5: upload ===

describe("apiUser — upload", () => {
  it("posts multipart and returns {url}", async () => {
    setUserSessionTokens("tok", "rt");
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(json(1000, { url: "https://cdn/x.png" }) as any);
    const file = new File(["data"], "a.png", { type: "image/png" });
    const r = await apiUser.upload(file);
    expect(r.url).toBe("https://cdn/x.png");
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/app/base/comm/upload");
    expect(init.method).toBe("POST");
    const body = init.body as FormData;
    expect(body.get("file")).toBeInstanceOf(File);
    // multipart 且未强制 JSON content-type
    expect((init.headers as Record<string, string>)["Content-Type"]).toBeUndefined();
    expect((init.headers as Record<string, string>).Authorization).toBe("tok");
  });
});
