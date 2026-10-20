// Motor da versão HTML (Web Worker): carrega o Python no navegador (Pyodide), o leitor de LiDAR
// (laz-perf) e o código do app (app/*.py), e atende os pedidos da tela enviados por ponte.js.
// Roda fora da tela para ela não travar durante o cálculo.
"use strict";

let BASE = self.location.protocol === "blob:" ? "" : new URL("../motor/", self.location.href).href;  // blob: arquivo único
let py = null, laz = null, iniciando = null;

function avisar(id, tipo, dado) { self.postMessage({ id, tipo, dado }); }

// Versão em arquivo .html único (aberto direto do disco): a página manda todos os arquivos do motor já
// lidos (cfg.embutido: caminho -> ArrayBuffer). Os pedidos a ENDERECO_EMBUTIDO são atendidos daqui.
const ENDERECO_EMBUTIDO = "https://calculadora.embutido/";
function usarEmbutidos(arquivos) {
  const fetchRede = self.fetch.bind(self);
  self.fetch = (recurso, opcoes) => {
    const url = recurso instanceof Request ? recurso.url : String(recurso);  // texto, URL ou Request
    if (!url.startsWith(ENDERECO_EMBUTIDO)) return fetchRede(recurso, opcoes);
    const caminho = url.slice(ENDERECO_EMBUTIDO.length).split("?")[0];
    const dado = arquivos[caminho];
    if (!dado) return Promise.resolve(new Response("", { status: 404 }));
    const tipo = caminho.endsWith(".wasm") ? "application/wasm" : "application/octet-stream";
    return Promise.resolve(new Response(dado.slice(0), { status: 200, headers: { "Content-Type": tipo } }));
  };
  const script = (c) => URL.createObjectURL(new Blob([arquivos[c]], { type: "text/javascript" }));
  // pyodide.asm.js carregado antes: o pyodide.js só busca o arquivo se _createPyodideModule não existir.
  importScripts(script("pyodide/pyodide.js"), script("pyodide/pyodide.asm.js"), script("motor/laz-perf.js"));
  BASE = ENDERECO_EMBUTIDO + "motor/";
  return ENDERECO_EMBUTIDO + "pyodide/";
}

async function iniciar(cfg) {
  if (cfg.embutido) cfg = { ...cfg, pyodide: usarEmbutidos(cfg.embutido), embutido: null };
  else importScripts(cfg.pyodide + "pyodide.js", BASE + "laz-perf.js");
  const [p, l] = await Promise.all([
    loadPyodide({ indexURL: cfg.pyodide }),
    createLazPerf({ locateFile: (f) => BASE + f }),
  ]);
  py = p; laz = l;
  await py.loadPackage(["numpy", "shapely", "pyproj", "sqlite3", "requests", "pyodide-http"]);
  await py.loadPackage([BASE + "et_xmlfile-2.0.0-py3-none-any.whl", BASE + "openpyxl-3.1.5-py2.py3-none-any.whl"]);
  // Cache do GeoSampa, recortes do LiDAR e tabela do Quadro 3 editada: guardados no navegador (IndexedDB).
  py.FS.mkdirTree("/persist");
  py.FS.mount(py.FS.filesystems.IDBFS, {}, "/persist");
  await sincronizar(true);
  const [zip, ponte] = await Promise.all([
    fetch(BASE + "app.zip?v=" + cfg.versao).then(ok("app.zip")).then((r) => r.arrayBuffer()),
    fetch(BASE + "ponte.py?v=" + cfg.versao).then(ok("ponte.py")).then((r) => r.text()),
  ]);
  py.FS.writeFile("/calc.zip", new Uint8Array(zip));
  py.runPython(ponte);
  return py.globals.get("iniciar")(cfg.relay, cfg.site);
}

function ok(nome) { return (r) => { if (!r.ok) throw new Error(`${nome}: HTTP ${r.status}`); return r; }; }

let filaSync = Promise.resolve();
function sincronizar(carregar) {  // uma gravação por vez no IndexedDB
  filaSync = filaSync.then(() => new Promise((resolve) =>
    py.FS.syncfs(carregar, (e) => { if (e) console.warn("IndexedDB:", e); resolve(); })));
  return filaSync;
}

// Chamada pelo Python (app/lidar.py, versão navegador): lê a folha .laz já gravada no disco virtual e
// devolve só os pontos dentro da caixa, em sequência x, y, z[, classe].
self.lazRecorte = function (caminho, comClasse, x0, y0, x1, y1) {
  const buf = py.FS.readFile(caminho);
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  // Cabeçalho LAS: escalas e deslocamentos de x, y, z (posições 131 a 178, iguais nas versões 1.0 a 1.4).
  const sx = dv.getFloat64(131, true), sy = dv.getFloat64(139, true), sz = dv.getFloat64(147, true);
  const ox = dv.getFloat64(155, true), oy = dv.getFloat64(163, true), oz = dv.getFloat64(171, true);
  const pIn = laz._malloc(buf.length);
  laz.HEAPU8.set(buf, pIn);
  const leitor = new laz.LASZip();
  try {
    leitor.open(pIn, buf.length);
    const n = leitor.getCount(), tam = leitor.getPointLength(), formato = leitor.getPointFormat();
    const posClasse = formato >= 6 ? 16 : 15;  // formatos 6 a 10: byte próprio; 0 a 5: 5 bits baixos
    const pPt = laz._malloc(tam);
    const k = comClasse ? 4 : 3;
    let saida = new Float64Array(Math.min(n, 1 << 20) * k), m = 0;
    try {
      for (let i = 0; i < n; i++) {
        leitor.getPoint(pPt);
        const heap = laz.HEAPU8;
        const v = new DataView(heap.buffer, pPt, tam);
        const x = v.getInt32(0, true) * sx + ox;
        if (x < x0 || x > x1) continue;
        const y = v.getInt32(4, true) * sy + oy;
        if (y < y0 || y > y1) continue;
        if ((m + 1) * k > saida.length) { const maior = new Float64Array(saida.length * 2); maior.set(saida); saida = maior; }
        const o = m * k;
        saida[o] = x; saida[o + 1] = y; saida[o + 2] = v.getInt32(8, true) * sz + oz;
        if (comClasse) saida[o + 3] = formato >= 6 ? heap[pPt + posClasse] : heap[pPt + posClasse] & 31;
        m++;
      }
    } finally { laz._free(pPt); }
    return saida.slice(0, m * k);
  } finally { leitor.delete(); laz._free(pIn); }
};

self.onmessage = async (e) => {
  const { id, op, args } = e.data;
  try {
    if (op === "iniciar") { iniciando = iniciando || iniciar(args); avisar(id, "resposta", await iniciando); return; }
    await iniciando;
    if (op === "stream") {
      const emitir = (tipo, dado) => avisar(id, tipo, JSON.parse(dado));
      py.globals.get("analisar_stream")(args.setor, args.quadra, !!args.recarregar, emitir);
      await sincronizar(false);
      return;
    }
    if (op === "api") {
      const r = py.globals.get("api")(args.metodo, args.caminho, args.corpo ?? null).toJs({ dict_converter: Object.fromEntries });
      if (r.json !== undefined) r.json = JSON.parse(r.json);
      if (r.bytes) r.bytes = new Uint8Array(r.bytes);
      if (args.metodo !== "GET") await sincronizar(false);
      avisar(id, "resposta", r);
      return;
    }
    throw new Error("operação desconhecida: " + op);
  } catch (err) {
    avisar(id, "falha", String(err && err.message || err));
  }
};
