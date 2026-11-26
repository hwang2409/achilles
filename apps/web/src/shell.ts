export function shellHeaders(): HeadersInit {
  const token = document.querySelector<HTMLMetaElement>('meta[name="achilles-shell"]')?.content;
  return token ? { "X-Achilles-Shell": token } : {};
}
