/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Base URL of the translator-api Worker. See .env.example. */
  readonly VITE_TRANSLATION_API_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
