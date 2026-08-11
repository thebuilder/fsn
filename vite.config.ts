import { defineConfig } from "vite";

/**
 * Link scrapers do not resolve relative URLs, so the canonical and Open Graph tags
 * need an absolute origin baked in at build time.
 *
 * `VERCEL_PROJECT_PRODUCTION_URL` is the project's production domain (no scheme),
 * and it stays pointed at production even on preview deployments — which is what we
 * want, so a shared preview link still previews the real card rather than a
 * throwaway deployment URL. `SITE_URL` overrides it for other hosts.
 */
function resolveSiteUrl(): string {
  const explicit = process.env.SITE_URL;
  if (explicit) return explicit.replace(/\/+$/, "");
  const vercel = process.env.VERCEL_PROJECT_PRODUCTION_URL;
  if (vercel) return `https://${vercel.replace(/\/+$/, "")}`;
  return "http://localhost:5173";
}

export default defineConfig(() => {
  const siteUrl = resolveSiteUrl();
  return {
    plugins: [
      {
        name: "fsn-site-url",
        transformIndexHtml: {
          // Ahead of Vite's own %VAR% env substitution, so the two never interact.
          order: "pre" as const,
          handler: (html: string) => html.replaceAll("__SITE_URL__", siteUrl),
        },
      },
    ],
  };
});
