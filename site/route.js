/* Legacy installed PWA and shared links must bypass the marketing page. */
(() => {
  const url = new URL(location.href);
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true || matchMedia('(display-mode: fullscreen)').matches;
  if (standalone || url.searchParams.has('ensemble') || url.searchParams.has('member')) {
    const target = new URL('app/', document.baseURI);
    target.search = url.search; target.hash = url.hash;
    location.replace(target.href);
  }
  if (/\.netlify\.app$/i.test(location.hostname) || /^dev\./i.test(location.hostname) || ['localhost','127.0.0.1'].includes(location.hostname)) { document.documentElement.dataset.environment = 'dev'; const meta = document.createElement('meta'); meta.name = 'robots'; meta.content = 'noindex, nofollow'; document.head.appendChild(meta); }
})();
