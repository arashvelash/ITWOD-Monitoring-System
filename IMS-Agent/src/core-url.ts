/** Validates and normalises the Core base URL (HTTPS only unless explicitly allowed for development). */
export function normalizeCoreUrl(raw: string, allowInsecure = process.env.IMS_ALLOW_INSECURE_CORE === 'true'): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error(`Invalid Core URL: ${raw}`);
  }
  if (url.protocol !== 'https:' && !(allowInsecure && url.protocol === 'http:')) {
    throw new Error('Core URL must use https://');
  }
  if (url.username || url.password || url.search || url.hash) throw new Error('Core URL must not contain credentials, query or fragment');
  return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, '')}`;
}

export function toWsUrl(coreUrl: string, path: string): string {
  const u = new URL(coreUrl);
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
  u.pathname = path;
  return u.toString();
}
