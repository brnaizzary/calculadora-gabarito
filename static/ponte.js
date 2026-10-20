// Versão HTML: a tela (app.js) é a mesma do servidor. Este arquivo atende os pedidos "/api/..." da tela
// dentro do próprio navegador, enviando-os ao motor (motor.js, Web Worker com o código Python do app).
// Carregado antes de app.js. Configuração em config-web.js (window.CALC_CONFIG).
"use strict";
(() => {
  const CFG = window.CALC_CONFIG;
  const motor = new Worker("static/motor.js?v=" + CFG.versao);
  const pendentes = new Map();
  let seq = 0;

  motor.onmessage = (e) => { const h = pendentes.get(e.data.id); if (h) h(e.data); };
  motor.onerror = (e) => {
    const msg = "O motor de cálculo parou (" + (e.message || "erro no navegador") + "). Recarregue a página.";
    pendentes.forEach((h, id) => h({ id, tipo: "falha", dado: msg }));
  };

  // Chamada simples: resolve com a primeira mensagem "resposta" (ou rejeita com "falha").
  function chamar(op, args) {
    return new Promise((resolve, reject) => {
      const id = ++seq;
      pendentes.set(id, (m) => {
        pendentes.delete(id);
        m.tipo === "resposta" ? resolve(m.dado) : reject(new Error(m.dado));
      });
      motor.postMessage({ id, op, args });
    });
  }

  // Endereços relativos valem a partir da página (o motor roda em static/).
  const pronto = chamar("iniciar", { ...CFG, pyodide: new URL(CFG.pyodide, location.href).href,
    relay: new URL(CFG.relay || ".", location.href).href, site: new URL(".", location.href).href });
  pronto.catch(() => {});

  // ---- etapa extra no painel de progresso: carregar o motor (só demora no 1º acesso).
  // ETAPAS é const global de app.js, que roda depois deste arquivo e antes do DOMContentLoaded.
  document.addEventListener("DOMContentLoaded", () => {
    try {
      if (!("motor" in ETAPAS)) {
        const antes = Object.entries(ETAPAS);
        antes.forEach(([k]) => delete ETAPAS[k]);
        ETAPAS.motor = "Preparando o motor de cálculo no navegador";
        antes.forEach(([k, v]) => { ETAPAS[k] = v; });
      }
    } catch (_) {}
  });

  function resposta(status, json) {
    return new Response(JSON.stringify(json), { status, headers: { "Content-Type": "application/json" } });
  }

  // ---- fetch("/api/...") da tela
  const fetchRede = window.fetch.bind(window);
  window.fetch = async (recurso, opcoes = {}) => {
    const url = typeof recurso === "string" ? recurso : recurso.url;
    if (!url.startsWith("/api/")) return fetchRede(recurso, opcoes);
    const caminho = url.split("?")[0];
    const metodo = (opcoes.method || "GET").toUpperCase();
    if (caminho === "/api/imagem") {
      return resposta(503, { detail: "A leitura de print não está disponível na versão HTML. Informe o Setor e a Quadra." });
    }
    try {
      await pronto;
      const r = await chamar("api", { metodo, caminho, corpo: typeof opcoes.body === "string" ? opcoes.body : null });
      if (r.bytes) {
        return new Response(r.bytes, { status: r.status, headers: { "Content-Type": r.tipo, "Content-Disposition": `attachment; filename="${r.nome}"` } });
      }
      return resposta(r.status, r.json);
    } catch (err) {
      return resposta(503, { detail: err.message });
    }
  };

  // ---- EventSource("/api/analisar/stream?...") da tela
  const EventSourceRede = window.EventSource;
  class EventSourceNavegador {
    constructor(url) {
      this.readyState = 0; this.ouvintes = {}; this.onerror = null;
      const q = new URL(url, location.href).searchParams;
      const id = this.id = ++seq;
      pendentes.set(id, (m) => {
        if (this.readyState === 2) return;
        if (m.tipo === "falha") { this.emitir("erro", m.dado); return; }
        this.emitir(m.tipo, m.dado);
      });
      this.readyState = 1;
      this.emitir("etapa", "motor");
      pronto
        .then(() => motor.postMessage({ id, op: "stream", args: { setor: q.get("setor"), quadra: q.get("quadra"), recarregar: q.get("recarregar") === "true" } }))
        .catch((err) => this.emitir("erro", "Não foi possível preparar o motor de cálculo: " + err.message));
    }
    addEventListener(tipo, f) { (this.ouvintes[tipo] = this.ouvintes[tipo] || []).push(f); }
    emitir(tipo, dado) {
      if (this.readyState === 2) return;
      if (tipo === "resultado" || tipo === "erro") pendentes.delete(this.id);
      setTimeout(() => (this.ouvintes[tipo] || []).forEach((f) => f({ data: JSON.stringify(dado) })), 0);
    }
    close() { this.readyState = 2; pendentes.delete(this.id); }
  }
  window.EventSource = function (url, opcoes) {
    return String(url).startsWith("/api/") ? new EventSourceNavegador(url) : new EventSourceRede(url, opcoes);
  };

  // ---- PDF: no navegador o relatório abre numa janela pronta para "Salvar como PDF".
  // Como em app/relatorio.gerar_pdf: no máximo 4 páginas A4; primeiro aperta o espaçamento, depois encurta
  // a tabela de lotes (a lista completa está na planilha). Cada página é medida num quadro invisível.
  const TENTATIVAS = [[false, null], [true, null], [true, 16], [true, 12], [true, 8], [true, 4]];
  async function relatorioEmQuatroPaginas() {
    let r = null;
    for (const [compacto, linhas] of TENTATIVAS) {
      r = await chamar("api", { metodo: "POST", caminho: "/api/relatorio.html",
        corpo: JSON.stringify({ ...pedidoAtual(), _compacto: compacto, _max_linhas: linhas }) });
      if (r.status !== 200) throw new Error(r.json && r.json.detail || "erro " + r.status);
      if (await cabeEmA4(r.html, compacto)) return r;
    }
    return r;
  }
  async function cabeEmA4(html, compacto) {
    // Área útil da folha A4 com as margens do @page do relatório (normal 14/14/16 mm; compacto 11/13/13 mm).
    const largura = compacto ? 184 : 182, altura = compacto ? 273 : 267;
    const q = Object.assign(document.createElement("iframe"), { srcdoc: html });
    q.style.cssText = `position:fixed;left:-10000px;top:0;width:${largura}mm;height:400mm;border:0;visibility:hidden`;
    document.body.appendChild(q);
    try {
      await new Promise((ok) => { q.onload = ok; });
      const d = q.contentDocument;
      const regua = d.createElement("div"); regua.style.cssText = `height:${altura}mm;position:absolute`;
      d.body.appendChild(regua);
      const limite = regua.getBoundingClientRect().height * 0.98;  // folga para diferenças da impressão
      regua.remove();
      d.body.style.margin = "0";
      return [...d.querySelectorAll(".pagina")].every((s) => s.getBoundingClientRect().height <= limite);
    } finally { q.remove(); }
  }

  document.addEventListener("click", async (e) => {
    const botao = e.target.closest && e.target.closest("#btn-pdf");
    if (!botao) return;
    e.preventDefault(); e.stopImmediatePropagation();
    if (!estado.setor) return;
    const janela = window.open("", "_blank");
    if (janela) janela.document.write('<p style="font:16px system-ui;padding:24px">Montando o relatório…</p>');
    const texto = botao.textContent; botao.disabled = true; botao.textContent = "Gerando…";
    try {
      await pronto;
      const r = await relatorioEmQuatroPaginas();
      const titulo = r.nome.replace(/\.pdf$/, "");
      const html = r.html.replace(/<title>[^<]*<\/title>/, "").replace(/<head>/i, `<head><title>${titulo}</title>`);
      if (!janela) throw new Error("o navegador bloqueou a janela do relatório. Permita janelas deste site e tente de novo.");
      janela.document.open(); janela.document.write(html); janela.document.close();
      const imprimir = () => { janela.focus(); janela.print(); };
      janela.document.readyState === "complete" ? setTimeout(imprimir, 300) : janela.addEventListener("load", () => setTimeout(imprimir, 300));
    } catch (err) {
      if (janela) janela.close();
      mostrarErro("Não foi possível gerar o relatório: " + err.message);
    } finally { botao.disabled = false; botao.textContent = texto; }
  }, true);
})();
