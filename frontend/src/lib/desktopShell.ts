export interface DesktopTabRequest {
  title: string;
  url: string;
}

interface TauriGlobal {
  core?: {
    invoke?: <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
  };
}

function tauriGlobal(): TauriGlobal | undefined {
  return (window as typeof window & { __TAURI__?: TauriGlobal }).__TAURI__;
}

export async function openDesktopTab(request: DesktopTabRequest): Promise<boolean> {
  const invoke = tauriGlobal()?.core?.invoke;
  if (!invoke) return false;

  await invoke("open_desktop_tab", { request });
  return true;
}
