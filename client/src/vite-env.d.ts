/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SOCKET_URL?: string;
  readonly VITE_CLOUDINARY_CLOUD_NAME?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
