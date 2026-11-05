/// <reference types="electron-vite/node" />

/** Build-time values electron-vite reads from the gitignored `.env` (written by `npm run google:client`). */
interface ImportMetaEnv {
  readonly MAIN_VITE_GOOGLE_CLIENT_ID?: string;
  readonly MAIN_VITE_GOOGLE_CLIENT_SECRET?: string;
}
