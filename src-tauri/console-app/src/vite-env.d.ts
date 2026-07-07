/// <reference types="vite/client" />

declare module "*/tauri.conf.json" {
  const conf: { version: string; [key: string]: unknown };
  export default conf;
}