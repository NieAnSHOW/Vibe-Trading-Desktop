// src/pages/profile/Profile.tsx
import { useState } from "react";
import { Loader2, LogOut, Save } from "lucide-react";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";
import { apiUser } from "@/lib/apiUser";
import { useAuthStore } from "@/stores/auth";

const fieldClass =
  "w-full rounded-md border bg-background px-3 py-2 text-sm outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/20";
const labelClass = "text-sm font-medium";

function maskPhone(p?: string | null) {
  if (!p || p.length < 7) return p || "";
  return `${p.slice(0, 3)}****${p.slice(-4)}`;
}

export function Profile() {
  const { t } = useTranslation();
  const userInfo = useAuthStore((s) => s.userInfo);
  const updateUser = useAuthStore((s) => s.updateUser);
  const logout = useAuthStore((s) => s.logout);

  const [nickName, setNickName] = useState(userInfo?.nickName || "");
  const [gender, setGender] = useState<number>(userInfo?.gender ?? 0);
  const [description, setDescription] = useState(userInfo?.description || "");
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);

  const save = async () => {
    setSaving(true);
    try {
      const updated = await apiUser.updatePerson({ nickName, gender, description });
      updateUser(updated);
      toast.success(t("profile.saved"));
    } catch (e) {
      toast.error((e as Error).message || t("profile.saveFailed"));
    } finally {
      setSaving(false);
    }
  };

  const onAvatar = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    try {
      const { url } = await apiUser.upload(file);
      const updated = await apiUser.updatePerson({ avatarUrl: url });
      updateUser(updated);
      toast.success(t("profile.avatarUpdated"));
    } catch (e) {
      toast.error((e as Error).message || t("profile.avatarFailed"));
    } finally {
      setUploading(false);
    }
  };

  const onLogout = () => {
    logout();
  };

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">{t("profile.title")}</h1>
      </div>

      <div className="grid gap-6 lg:grid-cols-[minmax(220px,0.6fr)_minmax(0,1.4fr)]">
        {/* Left: avatar + phone + logout */}
        <section className="rounded-lg border bg-card p-5 shadow-sm">
          <label className="block cursor-pointer">
            <div className="mx-auto flex h-24 w-24 items-center justify-center overflow-hidden rounded-full bg-muted">
              {userInfo?.avatarUrl ? (
                <img src={userInfo.avatarUrl} alt="avatar" className="h-full w-full object-cover" />
              ) : uploading ? (
                <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
              ) : (
                <span className="text-3xl text-muted-foreground">
                  {(nickName || "?").slice(0, 1).toUpperCase()}
                </span>
              )}
            </div>
            <input type="file" accept="image/*" className="hidden" onChange={onAvatar} />
          </label>

          <div className="mt-4 space-y-2 text-sm">
            <div>
              <div className="text-xs text-muted-foreground">{t("profile.phone")}</div>
              <div className="font-medium">{maskPhone(userInfo?.phone)}</div>
            </div>
            <button
              type="button"
              onClick={onLogout}
              className="mt-3 inline-flex w-full items-center justify-center gap-2 rounded-md border border-destructive/40 px-3 py-2 text-sm font-medium text-destructive transition hover:bg-destructive/10"
            >
              <LogOut className="h-4 w-4" />
              {t("profile.logout")}
            </button>
          </div>
        </section>

        {/* Right: editable fields */}
        <section className="rounded-lg border bg-card p-5 shadow-sm">
          <div className="grid gap-4">
            <label className="grid gap-2">
              <span className={labelClass}>{t("profile.nickName")}</span>
              <input className={fieldClass} value={nickName} onChange={(e) => setNickName(e.target.value)} />
            </label>

            <div className="grid gap-2">
              <span className={labelClass}>{t("profile.gender")}</span>
              <div className="flex gap-4 text-sm">
                {[0, 1, 2].map((g) => (
                  <label key={g} className="flex items-center gap-1.5">
                    <input
                      type="radio"
                      name="gender"
                      checked={gender === g}
                      onChange={() => setGender(g)}
                      className="h-3.5 w-3.5 accent-primary"
                    />
                    {t(`profile.genderOptions.${g}`)}
                  </label>
                ))}
              </div>
            </div>

            <label className="grid gap-2">
              <span className={labelClass}>{t("profile.description")}</span>
              <textarea
                className={fieldClass}
                rows={3}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
            </label>

            <button
              type="button"
              onClick={save}
              disabled={saving}
              className="inline-flex items-center justify-center gap-2 self-start rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:opacity-60"
            >
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
              {t("profile.save")}
            </button>
          </div>
        </section>
      </div>
    </div>
  );
}
