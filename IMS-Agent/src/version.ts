// Replaced at build time by esbuild (scripts/build.mjs).
declare const __IMS_AGENT_VERSION__: string | undefined;

export const AGENT_VERSION: string = typeof __IMS_AGENT_VERSION__ === 'string' ? __IMS_AGENT_VERSION__ : '0.0.0-dev';
export const AGENT_TYPE = 'UBUNTU' as const;
