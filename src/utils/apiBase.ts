// The Vercel deployment serves the frontend and the /api/* backend from
// the same origin, so relative paths work as-is (VITE_API_BASE_URL unset).
// The Firebase Hosting mirror serves only this static frontend - it has no
// backend of its own - so its build sets VITE_API_BASE_URL to the Vercel
// deployment's URL and every API call is routed there instead.
const API_BASE = (import.meta as unknown as { env: Record<string, string | undefined> }).env.VITE_API_BASE_URL || '';

export function apiUrl(path: string): string {
  return `${API_BASE}${path}`;
}
