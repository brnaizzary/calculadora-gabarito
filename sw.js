// Service worker da versão HTML: permite instalar o app e guarda no aparelho os arquivos grandes do
// motor (Python no navegador, cerca de 30 MB), para que só o primeiro acesso seja lento.
// Os dados do GeoSampa não passam por aqui (ficam no cache do próprio motor).
const VERSAO = "85c996e097";
const CACHE = "motor-" + VERSAO;
const AVISO = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Calculadora · Quebra de Gabarito</title>
<body style="font:16px system-ui,sans-serif;padding:32px;color:#1c2430;background:#f5f6f8">
<h1 style="font-size:20px">Sem conexão</h1>
<p>O app precisa de internet para consultar o GeoSampa. Confira a conexão e tente de novo.</p></body>`;

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil((async () => {
  for (const k of await caches.keys()) if (k.startsWith("motor-") && k !== CACHE) await caches.delete(k);
  await self.clients.claim();
})()));
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method === "GET" && url.origin === location.origin && /\/(pyodide|motor)\//.test(url.pathname)
      && !url.pathname.includes("/motor/cache/")) {  // pacotes de quadra: guardados pelo motor, não aqui
    e.respondWith(caches.open(CACHE).then(async (c) => {
      const salvo = await c.match(e.request);
      if (salvo) return salvo;
      const r = await fetch(e.request);
      if (r.ok) c.put(e.request, r.clone());
      return r;
    }));
    return;
  }
  if (e.request.mode !== "navigate") return;
  e.respondWith(fetch(e.request).catch(() => new Response(AVISO, { headers: { "Content-Type": "text/html; charset=utf-8" } })));
});
