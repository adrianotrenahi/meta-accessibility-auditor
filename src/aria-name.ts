/** Read the quoted accessible name, retaining literal quotes/backslashes correctly. */
export function originalAriaName(aria: string, fallback = '') {
  const literal = aria.split('\n')[0]?.match(/"(?:\\.|[^"\\])*"/)?.[0];
  if (!literal) return fallback;
  try {
    return JSON.parse(literal) as string;
  } catch {
    return fallback;
  }
}
