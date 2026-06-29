// src/pages/auth/Login.tsx
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Loader2, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";
import { apiUser } from "@/lib/apiUser";
import { api } from "@/lib/api";
import { useAuthStore } from "@/stores/auth";
import { SetPasswordModal } from "@/components/auth/SetPasswordModal";

const fieldClass =
  "w-full rounded-md border bg-background px-3 py-2 text-sm outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/20 disabled:opacity-60";
const hintClass = "text-xs text-muted-foreground";

const PHONE_RE = /^1\d{10}$/;
const isCode4 = (s: string) => /^\d{4}$/.test(s) || /^[0-9a-zA-Z]{4}$/.test(s);

type Tab = "sms" | "password";

/** 登录成功后自动配置 LLM 设置到 Maas 端点 */
async function autoConfigLLM(token: string) {
  try {
    const userApiBase =
      import.meta.env.VITE_USER_API_URL || "https://maas.nieanshow.cn";
    await api.updateLLMSettings({
      provider: "openai",
      model_name: "deepseek-v4-flash",
      base_url: `${userApiBase}/v1`,
      api_key: token,
      temperature: 0,
      timeout_seconds: 120,
      max_retries: 2,
      reasoning_effort: "",
    });
  } catch {
    // 静默失败，不影响登录流程
  }
}

export function Login() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const setSession = useAuthStore((s) => s.setSession);
  const fetchUserInfo = useAuthStore((s) => s.fetchUserInfo);
  const status = useAuthStore((s) => s.status);

  const [tab, setTab] = useState<Tab>("sms");
  const [captcha, setCaptcha] = useState<{
    captchaId: string;
    data: string;
  } | null>(null);
  const [phone, setPhone] = useState("");
  const [captchaCode, setCaptchaCode] = useState("");
  const [smsCode, setSmsCode] = useState("");
  const [password, setPassword] = useState("");
  const [countdown, setCountdown] = useState(0);
  const [sending, setSending] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [showSetPwd, setShowSetPwd] = useState(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const loadCaptcha = async () => {
    try {
      const c = await apiUser.getCaptcha({ width: 120, height: 40 });
      setCaptcha(c);
    } catch (e) {
      toast.error((e as Error).message || t("auth.errors.captchaLoad"));
    }
  };

  useEffect(() => {
    void loadCaptcha();
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 已登录则跳走
  useEffect(() => {
    if (status === "authenticated" && !showSetPwd) navigate("/profile", { replace: true });
  }, [status, navigate, showSetPwd]);

  const phoneValid = PHONE_RE.test(phone);
  const captchaValid = isCode4(captchaCode);
  const smsValid = isCode4(smsCode);
  const passwordValid = password.length >= 6;

  const sendCode = async () => {
    if (!phoneValid || !captchaValid || sending || countdown > 0) return;
    if (!captcha) return;
    setSending(true);
    try {
      await apiUser.sendSmsCode(phone, captcha.captchaId, captchaCode);
      setCountdown(60);
      timerRef.current = setInterval(() => {
        setCountdown((n) => {
          if (n <= 1) {
            if (timerRef.current) clearInterval(timerRef.current);
            return 0;
          }
          return n - 1;
        });
      }, 1000);
      toast.success(t("auth.smsSent"));
    } catch (e) {
      toast.error((e as Error).message || t("auth.errors.smsFailed"));
      void loadCaptcha();
    } finally {
      setSending(false);
    }
  };

  const finishSession = async (
    r: { token: string; refreshToken: string; expire: number; hasPassword: boolean },
    onFailRefreshCaptcha: boolean
  ) => {
    if (!r.hasPassword) {
      setShowSetPwd(true);
    }
    setSession(r);
    await fetchUserInfo();
    autoConfigLLM(r.token);
    if (r.hasPassword) {
      toast.success(t("auth.loginSuccess"));
      navigate("/profile", { replace: true });
    }
    if (onFailRefreshCaptcha) void loadCaptcha();
  };

  const submitSms = async () => {
    if (!phoneValid || !smsValid || submitting) return;
    setSubmitting(true);
    try {
      const r = await apiUser.loginByPhone(phone, smsCode);
      await finishSession(r, false);
    } catch (e) {
      toast.error((e as Error).message || t("auth.errors.loginFailed"));
      void loadCaptcha();
    } finally {
      setSubmitting(false);
    }
  };

  const submitPassword = async () => {
    if (!phoneValid || !passwordValid || submitting) return;
    setSubmitting(true);
    try {
      const r = await apiUser.loginByPassword(phone, password);
      await finishSession(r, false);
    } catch (e) {
      toast.error((e as Error).message || t("auth.errors.passwordLoginFailed"));
    } finally {
      setSubmitting(false);
    }
  };

  const tabBtn = (which: Tab) =>
    `flex-1 px-3 py-2 text-sm font-medium transition ${
      tab === which
        ? "border-b-2 border-primary text-primary"
        : "text-muted-foreground hover:text-foreground"
    }`;

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4">
      <div className="w-full max-w-sm rounded-lg border bg-card p-6 shadow-sm">
        <h1 className="mb-1 text-xl font-semibold tracking-tight">
          {t("auth.title")}
        </h1>
        <p className="mb-5 text-xs text-muted-foreground">{t("auth.subtitle")}</p>

        <div className="mb-4 flex gap-2">
          <button type="button" className={tabBtn("sms")} onClick={() => setTab("sms")}>
            {t("auth.tab.sms")}
          </button>
          <button type="button" className={tabBtn("password")} onClick={() => setTab("password")}>
            {t("auth.tab.password")}
          </button>
        </div>

        {tab === "sms" ? (
          <div className="space-y-4">
            <label className="grid gap-1.5">
              <span className="text-sm font-medium">{t("auth.phone")}</span>
              <input
                className={fieldClass}
                value={phone}
                onChange={(e) => setPhone(e.target.value.replace(/\D/g, "").slice(0, 11))}
                placeholder="13800000000"
                inputMode="numeric"
              />
            </label>

            <label className="grid gap-1.5">
              <span className="text-sm font-medium">{t("auth.captcha")}</span>
              <div className="flex gap-2">
                <input
                  className={fieldClass}
                  value={captchaCode}
                  onChange={(e) => setCaptchaCode(e.target.value.trim().slice(0, 4))}
                  placeholder="abcd"
                />
                <button
                  type="button"
                  onClick={loadCaptcha}
                  title={t("auth.refreshCaptcha")}
                  className="flex h-[38px] w-[120px] shrink-0 items-center justify-center overflow-hidden rounded-md border bg-[#70634e]"
                >
                  {captcha ? (
                    <img
                      src={
                        captcha.data.startsWith("data:")
                          ? captcha.data
                          : `data:image/svg+xml;base64,${captcha.data}`
                      }
                      alt="captcha"
                      className="h-full w-full object-cover"
                    />
                  ) : (
                    <RefreshCw className="h-4 w-4 animate-spin text-muted-foreground" />
                  )}
                </button>
              </div>
            </label>

            <label className="grid gap-1.5">
              <span className="text-sm font-medium">{t("auth.smsCode")}</span>
              <div className="flex gap-2">
                <input
                  className={fieldClass}
                  value={smsCode}
                  onChange={(e) => setSmsCode(e.target.value.trim().slice(0, 4))}
                  placeholder="1234"
                  inputMode="numeric"
                />
                <button
                  type="button"
                  onClick={sendCode}
                  disabled={!phoneValid || !captchaValid || sending || countdown > 0}
                  className="inline-flex h-[38px] shrink-0 items-center justify-center gap-1 rounded-md border px-3 text-xs font-medium transition hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {countdown > 0 ? (
                    t("auth.countdown", { n: countdown })
                  ) : sending ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    t("auth.getCode")
                  )}
                </button>
              </div>
            </label>

            <button
              type="button"
              onClick={submitSms}
              disabled={!phoneValid || !smsValid || submitting}
              className="inline-flex w-full items-center justify-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              {t("auth.submit")}
            </button>
            <p className={hintClass}>{t("auth.firstLoginHint")}</p>
          </div>
        ) : (
          <div className="space-y-4">
            <label className="grid gap-1.5">
              <span className="text-sm font-medium">{t("auth.phone")}</span>
              <input
                className={fieldClass}
                value={phone}
                onChange={(e) => setPhone(e.target.value.replace(/\D/g, "").slice(0, 11))}
                placeholder="13800000000"
                inputMode="numeric"
              />
            </label>

            <label className="grid gap-1.5">
              <span className="text-sm font-medium">{t("auth.password")}</span>
              <input
                className={fieldClass}
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="******"
              />
            </label>

            <button
              type="button"
              onClick={submitPassword}
              disabled={!phoneValid || !passwordValid || submitting}
              className="inline-flex w-full items-center justify-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              {t("auth.submit")}
            </button>
          </div>
        )}

        <button
          type="button"
          onClick={() => navigate("/", { replace: true })}
          className="mt-4 inline-flex w-full items-center justify-center gap-2 rounded-md border px-4 py-2 text-sm font-medium transition hover:bg-muted"
        >
          {t("auth.backToHome")}
        </button>
      </div>

      <SetPasswordModal
        open={showSetPwd}
        onClose={() => {
          setShowSetPwd(false);
          toast.success(t("auth.loginSuccess"));
          navigate("/profile", { replace: true });
        }}
      />
    </div>
  );
}
