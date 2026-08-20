export const WEBUI_AUTH_EVENT = "vibe-shell:auth";

export type WebuiAuthMessage = "vibe-shell:auth-login" | "vibe-shell:auth-logout";

/** Notify the retained WebUI iframe about a console authentication transition. */
export function notifyWebuiAuth(message: WebuiAuthMessage): void {
  window.dispatchEvent(new CustomEvent(WEBUI_AUTH_EVENT, { detail: message }));
}
