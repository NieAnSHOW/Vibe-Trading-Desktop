// src/pages/auth/Login.tsx
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  ArrowLeft,
  CheckCircle2,
  KeyRound,
  Loader2,
  LockKeyhole,
  MessageSquareText,
  RefreshCw,
  ShieldCheck,
  Smartphone,
} from "lucide-react";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";
import { apiUser } from "@/lib/apiUser";
import { api } from "@/lib/api";
import { useAuthStore } from "@/stores/auth";
import { SetPasswordModal } from "@/components/auth/SetPasswordModal";

const fieldClass =
  "h-11 w-full rounded-lg border bg-background px-3 text-sm outline-none transition placeholder:text-muted-foreground focus:border-primary focus:ring-2 focus:ring-primary/20 disabled:cursor-not-allowed disabled:opacity-60";
const secondaryButtonClass =
  "inline-flex h-11 items-center justify-center gap-2 rounded-lg border bg-background px-4 text-sm font-semibold text-foreground transition hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50";
const primaryButtonClass =
  "inline-flex h-11 w-full items-center justify-center gap-2 rounded-lg bg-primary px-4 text-sm font-semibold text-primary-foreground transition hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-60";
const hintClass = "text-sm leading-6 text-muted-foreground";

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
    r: { token: string; refreshToken: string; expire: number; refreshExpire: number; hasPassword: boolean },
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
    `inline-flex h-9 flex-1 items-center justify-center gap-2 rounded-md px-3 text-sm font-semibold transition ${
      tab === which
        ? "bg-card text-foreground"
        : "text-muted-foreground hover:text-foreground"
    }`;

  const trustItems = [
    {
      icon: ShieldCheck,
      title: t("auth.trust.localSessionTitle"),
      desc: t("auth.trust.localSessionDesc"),
    },
    {
      icon: LockKeyhole,
      title: t("auth.trust.mandateTitle"),
      desc: t("auth.trust.mandateDesc"),
    },
    {
      icon: CheckCircle2,
      title: t("auth.trust.researchTitle"),
      desc: t("auth.trust.researchDesc"),
    },
  ];

  return (
    <div className="min-h-screen bg-background px-4 py-6 sm:px-6 lg:px-8">
      <div className="mx-auto grid min-h-[calc(100vh-3rem)] w-full max-w-6xl items-center gap-6 lg:grid-cols-[minmax(0,0.92fr)_minmax(420px,1fr)]">
        <aside className="order-2 rounded-lg border bg-card p-5 lg:order-1 lg:p-7">
          <div className="inline-flex items-center gap-2 rounded-full border bg-muted/60 px-3 py-1 text-sm font-medium text-muted-foreground">
            <ShieldCheck className="h-4 w-4 text-primary" aria-hidden="true" />
            {t("auth.panelBadge")}
          </div>

          <div className="mt-6 space-y-3">
            <h1 className="text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">
              {t("auth.panelTitle")}
            </h1>
            <p className="max-w-xl text-sm leading-6 text-muted-foreground sm:text-base">
              {t("auth.panelSubtitle")}
            </p>
          </div>

          <div className="mt-8 grid gap-3">
            {trustItems.map(({ icon: Icon, title, desc }) => (
              <div key={title} className="rounded-lg border bg-background p-4">
                <div className="flex items-center gap-3">
                  <span className="rounded-lg bg-primary/10 p-2 text-primary">
                    <Icon className="h-4 w-4" aria-hidden="true" />
                  </span>
                  <h2 className="text-sm font-semibold text-foreground">{title}</h2>
                </div>
                <p className="mt-3 text-sm leading-6 text-muted-foreground">{desc}</p>
              </div>
            ))}
          </div>
        </aside>

        <main className="order-1 rounded-lg border bg-card p-5 lg:order-2 lg:p-7">
          <div className="mb-6">
            <p className="text-sm font-medium text-primary">{t("auth.formKicker")}</p>
            <h2 className="mt-2 text-2xl font-semibold tracking-tight text-foreground">
              {t("auth.title")}
            </h2>
            <p className="mt-2 text-sm leading-6 text-muted-foreground">{t("auth.subtitle")}</p>
          </div>

          <div className="mb-5 flex rounded-lg bg-muted p-1" aria-label={t("auth.title")}>
            <button type="button" aria-pressed={tab === "sms"} className={tabBtn("sms")} onClick={() => setTab("sms")}>
              <MessageSquareText className="h-4 w-4" aria-hidden="true" />
              {t("auth.tab.sms")}
            </button>
            <button type="button" aria-pressed={tab === "password"} className={tabBtn("password")} onClick={() => setTab("password")}>
              <KeyRound className="h-4 w-4" aria-hidden="true" />
              {t("auth.tab.password")}
            </button>
          </div>

          {tab === "sms" ? (
            <div className="space-y-4">
              <label className="grid gap-2" htmlFor="login-phone-sms">
                <span className="text-sm font-semibold">{t("auth.phone")}</span>
              <input
                id="login-phone-sms"
                className={fieldClass}
                value={phone}
                onChange={(e) => setPhone(e.target.value.replace(/\D/g, "").slice(0, 11))}
                placeholder="13800000000"
                inputMode="numeric"
              />
            </label>

              <div className="grid gap-2">
                <label className="text-sm font-semibold" htmlFor="login-captcha">
                  {t("auth.captcha")}
                </label>
              <div className="flex gap-2">
                <input
                  id="login-captcha"
                  className={fieldClass}
                  value={captchaCode}
                  onChange={(e) => setCaptchaCode(e.target.value.trim().slice(0, 4))}
                  placeholder="abcd"
                />
                <button
                  type="button"
                  onClick={loadCaptcha}
                  title={t("auth.refreshCaptcha")}
                    aria-label={t("auth.refreshCaptcha")}
                    className="flex h-11 w-[124px] shrink-0 items-center justify-center overflow-hidden rounded-lg border bg-muted"
                >
                  {captcha ? (
                    <img
                      src={
                        captcha.data.startsWith("data:")
                          ? captcha.data
                          : `data:image/svg+xml;base64,${captcha.data}`
                      }
                        alt=""
                        aria-hidden="true"
                      className="h-full w-full object-cover"
                    />
                  ) : (
                    <RefreshCw className="h-4 w-4 animate-spin text-muted-foreground" />
                  )}
                </button>
              </div>
              </div>

              <div className="grid gap-2">
                <label className="text-sm font-semibold" htmlFor="login-sms-code">
                  {t("auth.smsCode")}
                </label>
              <div className="flex gap-2">
                <input
                  id="login-sms-code"
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
                    className={`${secondaryButtonClass} w-[124px] shrink-0 px-3 text-xs`}
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
              </div>

            <button
              type="button"
              onClick={submitSms}
              disabled={!phoneValid || !smsValid || submitting}
                className={primaryButtonClass}
            >
              {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              {t("auth.submit")}
            </button>
            <p className={hintClass}>{t("auth.firstLoginHint")}</p>
          </div>
        ) : (
          <div className="space-y-4">
              <label className="grid gap-2" htmlFor="login-phone-password">
                <span className="text-sm font-semibold">{t("auth.phone")}</span>
              <input
                id="login-phone-password"
                className={fieldClass}
                value={phone}
                onChange={(e) => setPhone(e.target.value.replace(/\D/g, "").slice(0, 11))}
                placeholder="13800000000"
                inputMode="numeric"
              />
            </label>

              <label className="grid gap-2" htmlFor="login-password">
                <span className="text-sm font-semibold">{t("auth.password")}</span>
              <input
                id="login-password"
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
                className={primaryButtonClass}
            >
              {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              {t("auth.submit")}
            </button>
          </div>
          )}

          <div className="mt-5 rounded-lg bg-muted/50 p-3 text-sm leading-6 text-muted-foreground">
            <div className="flex gap-2">
              <Smartphone className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
              <span>{t("auth.formHint")}</span>
            </div>
          </div>

          <button
            type="button"
            onClick={() => navigate("/", { replace: true })}
            className="mt-4 inline-flex h-10 w-full items-center justify-center gap-2 rounded-lg border bg-background px-4 text-sm font-semibold transition hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          >
            <ArrowLeft className="h-4 w-4" aria-hidden="true" />
            {t("auth.backToHome")}
          </button>
        </main>
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
