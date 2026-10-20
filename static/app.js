const $ = (s) => document.querySelector(s);
// App instalável: o navegador só registra o service worker em HTTPS ou localhost.
if ("serviceWorker" in navigator && window.isSecureContext) navigator.serviceWorker.register("sw.js").catch(() => {});
const ETAPAS = { quadra: "Buscando a quadra", lotes: "Buscando lotes", edificacoes: "Buscando edificações",
  zoneamento: "Zoneamento e distrito", alturas: "Medindo alturas (LiDAR 2020)", calculo: "Calculando" };
const NOMES_SIT = { sim: "Sim", nao: "Não", a_confirmar: "A confirmar", sem_edificacao: "Sem edificação", sem_medicao: "Sem medição" };
const FONTE_ALT = { mdc: "MDC 2007", lidar: "LiDAR 2020", "3d_tiles": "Google 3D", alvara: "Alvará" };

let estado = { setor: null, quadra: null, res: null, manuais: {}, refManual: null, ordem: null, modoMapa: "mdc", estudo: [] };

const num = (v, d = 0) => v == null ? "—" : v.toLocaleString("pt-BR", { minimumFractionDigits: d, maximumFractionDigits: d });
const pct = (v) => v == null ? "—" : num(v, 1) + "%";
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const dataBR = (iso) => iso ? new Date(iso).toLocaleString("pt-BR") : "—";

$("#form").addEventListener("submit", (e) => { e.preventDefault(); iniciar($("#setor").value, $("#quadra").value); });
$("#refazer").addEventListener("click", () => {
  limparEstudo(); $("#setor").value = ""; $("#quadra").value = ""; $("#setor").focus();
});

let fluxo = null;  // consulta em andamento (EventSource), para poder interromper ao limpar

// Tira da tela qualquer estudo, progresso, erro ou leitura de print e zera o estado.
function limparEstudo() {
  if (fluxo) { fluxo.close(); fluxo = null; }
  clearInterval(estado.relogio);
  ["#resultado", "#progresso", "#erro", "#identificacao", "#aviso-campos"].forEach((s) => $(s).hidden = true);
  if (selecionando) encerrarSelecao();
  estado = { ...estado, setor: null, quadra: null, res: null, manuais: {}, refManual: null, ordem: null, estudo: [] };
  modoManual(); marcarSelecao();
}
$("#copiar").addEventListener("click", copiarResumo);
document.querySelectorAll(".alternar button").forEach((b) => b.addEventListener("click", () => {
  estado.modoMapa = b.dataset.modo; desenharMapa();
}));

// Altura manual: só aparece a coluna depois que o usuário escolhe essa opção e informa a base de referência.
$("#manual-abrir").addEventListener("click", () => {
  $("#dlg-ref").value = estado.refManual || ""; $("#dlg-manual").showModal(); $("#dlg-ref").focus();
});
$("#dlg-cancelar").addEventListener("click", () => $("#dlg-manual").close());
$("#dlg-form").addEventListener("submit", (e) => {
  const ref = $("#dlg-ref").value.trim();
  if (!ref) { e.preventDefault(); return; }
  estado.refManual = ref;
  Object.values(estado.manuais).forEach((m) => m.referencia = ref);
  modoManual(); tabela(estado.res);
});
$("#manual-desfazer").addEventListener("click", () => {
  const tinha = Object.keys(estado.manuais).length;
  estado.manuais = {}; estado.refManual = null; modoManual();
  if (tinha) recalcular(); else tabela(estado.res);
});

function modoManual() {
  const ativo = !!estado.refManual;
  $("#manual-abrir").hidden = ativo;
  $("#manual-desfazer").hidden = !ativo;
  $("#lotes-dica").textContent = ativo
    ? `Clique no cabeçalho para ordenar. Digite as alturas pela base "${estado.refManual}"; em branco, vale a medida automática. O cálculo é refeito na hora.`
    : "Clique no cabeçalho para ordenar.";
}

// Terreno em estudo: o usuário clica nos lotes do próprio mapa.
let selecionando = null;  // conjunto de lotes marcados enquanto a seleção está aberta
$("#estudo-destacar").addEventListener("click", () => {
  if (!selecionando) {
    selecionando = new Set(estado.estudo);
    $("#mapa-svg").classList.add("selecionando");
    $("#estudo-destacar").textContent = "Concluir seleção";
    $("#estudo-destacar").className = "primario";
    $("#estudo-aviso").textContent = "Clique nos lotes do terreno no mapa (clique de novo para desmarcar). Depois, clique em Concluir seleção.";
    marcarSelecao();
  } else {
    estado.estudo = [...selecionando];
    encerrarSelecao();
    recalcular();
  }
});
$("#estudo-limpar").addEventListener("click", () => {
  if (selecionando) selecionando.clear();
  estado.estudo = []; encerrarSelecao(); recalcular();
});
$("#mapa-svg").addEventListener("click", (e) => {
  const lote = e.target.closest("path[data-lote]");
  if (!selecionando || !lote) return;
  const id = lote.dataset.lote;
  selecionando.has(id) ? selecionando.delete(id) : selecionando.add(id);
  marcarSelecao();
});

function marcarSelecao() {
  const ids = selecionando || new Set(estado.estudo);
  $("#mapa-svg").querySelectorAll("path[data-lote]").forEach((p) => p.classList.toggle("selecionado", ids.has(p.dataset.lote)));
  $("#estudo-lista").textContent = ids.size ? [...ids].join(", ") : "nenhum";
  $("#estudo-limpar").hidden = !ids.size;
}

function encerrarSelecao() {
  selecionando = null;
  $("#mapa-svg").classList.remove("selecionando");
  $("#estudo-destacar").textContent = "Destacar no mapa";
  $("#estudo-destacar").className = "secundario";
  $("#estudo-aviso").textContent = "";
  marcarSelecao();
}

function desenharMapa() {
  const r = estado.res; if (!r) return;
  document.querySelectorAll(".alternar button").forEach((b) => b.classList.toggle("ativo", b.dataset.modo === estado.modoMapa));
  $("#mapa-svg").innerHTML = r.mapas?.[estado.modoMapa] || "<p class='dica'>Mapa indisponível (geometria da quadra não carregada).</p>";
  marcarSelecao();
}

function iniciar(setor, quadra) {
  setor = setor.trim(); quadra = quadra.trim();
  limparEstudo();
  if (!setor || !quadra) { $("#aviso-campos").hidden = false; ($("#setor").value.trim() ? $("#quadra") : $("#setor")).focus(); return; }
  if (!/^\d{1,3}$/.test(setor) || !/^\d{1,3}$/.test(quadra)) return mostrarErro("Setor e quadra fiscal têm até 3 dígitos cada (ex.: 036 e 052).");
  $("#progresso").hidden = false;
  const lista = $("#etapas"); lista.innerHTML = "";
  Object.entries(ETAPAS).forEach(([k, t]) => lista.insertAdjacentHTML("beforeend", `<li data-e="${k}">${t}</li>`));
  const t0 = Date.now();
  const relogio = estado.relogio = setInterval(() => {
    $("#tempo").textContent = `${Math.round((Date.now() - t0) / 1000)} s · primeira consulta leva até 90 s (GeoSampa + LiDAR); com cache, menos de 5 s.`;
  }, 500);
  const qs = `setor=${encodeURIComponent(setor)}&quadra=${encodeURIComponent(quadra)}`;
  const es = fluxo = new EventSource(`/api/analisar/stream?${qs}`);
  es.addEventListener("etapa", (ev) => {
    const atual = JSON.parse(ev.data); let passou = false;
    lista.querySelectorAll("li").forEach((li) => {
      li.className = li.dataset.e === atual ? (passou = true, "atual") : passou ? "" : "feito";
    });
  });
  es.addEventListener("resultado", (ev) => {
    es.close(); clearInterval(relogio); $("#progresso").hidden = true;
    const r = JSON.parse(ev.data);
    estado.setor = r.identificacao.setor; estado.quadra = r.identificacao.quadra;
    renderizar(r);
  });
  es.addEventListener("erro", (ev) => { es.close(); clearInterval(relogio); $("#progresso").hidden = true; mostrarErro(JSON.parse(ev.data)); });
  es.onerror = () => { if (es.readyState === 2) return; es.close(); clearInterval(relogio); $("#progresso").hidden = true; mostrarErro("Conexão com o servidor interrompida."); };
}

const zona = $("#soltar");
["dragenter", "dragover"].forEach((ev) => zona.addEventListener(ev, (e) => { e.preventDefault(); zona.classList.add("arrastando"); }));
["dragleave", "drop"].forEach((ev) => zona.addEventListener(ev, (e) => { e.preventDefault(); zona.classList.remove("arrastando"); }));
zona.addEventListener("drop", (e) => { const f = e.dataTransfer.files[0]; if (f) enviarImagem(f); });
$("#arquivo").addEventListener("change", (e) => { const f = e.target.files[0]; if (f) enviarImagem(f); e.target.value = ""; });

async function enviarImagem(arquivo) {
  $("#erro").hidden = true; $("#resultado").hidden = true;
  const sec = $("#identificacao"); sec.hidden = false;
  $("#ident-msg").textContent = "Lendo a imagem e procurando a quadra no GeoSampa (até ~20 s)…";
  $("#candidatos").innerHTML = ""; $("#texto-lido").textContent = "";
  const fd = new FormData(); fd.append("arquivo", arquivo);
  try {
    const r = await fetch("/api/imagem", { method: "POST", body: fd });
    const j = await r.json();
    if (!r.ok) throw new Error(j.detail || r.statusText);
    $("#ident-msg").textContent = j.mensagem;
    $("#texto-lido").textContent = j.texto_lido || "(nenhum texto legível)";
    $("#candidatos").innerHTML = j.candidatos.map((c, i) => `
      <div class="candidato">${c.svg || ""}
        <strong>Setor ${c.setor} · Quadra ${c.quadra}</strong>
        <span class="dica">Área MDC ${num(c.area, 0)} m²${i === 0 && j.candidatos.length > 1 ? " · mais provável" : ""}</span>
        <ul>${c.motivos.map((m) => `<li>${esc(m)}</li>`).join("")}</ul>
        <button class="primario" data-s="${c.setor}" data-q="${c.quadra}">Confirmar e analisar</button>
      </div>`).join("");
    $("#candidatos").querySelectorAll("button").forEach((b) => b.addEventListener("click", () => {
      $("#setor").value = b.dataset.s; $("#quadra").value = b.dataset.q; sec.hidden = true; iniciar(b.dataset.s, b.dataset.q);
    }));
  } catch (err) { $("#ident-msg").textContent = "Não foi possível ler a imagem: " + err.message; }
}

$("#btn-pdf").addEventListener("click", (e) => baixar(e.currentTarget, "/api/relatorio.pdf"));
$("#btn-xlsx").addEventListener("click", (e) => baixar(e.currentTarget, "/api/planilha.xlsx"));

function pedidoAtual() {
  return { setor: estado.setor, quadra: estado.quadra, gabarito_m: null,  // sempre o do Quadro 3 da zona
    criterio_edificado: null,  // metodologia fixa do app (critério "predio")
    alturas_manuais: estado.manuais, estudo: estado.estudo };
}

async function baixar(botao, url) {
  if (!estado.setor) return;
  const texto = botao.textContent; botao.disabled = true; botao.textContent = "Gerando…";
  try {
    const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(pedidoAtual()) });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || r.statusText);
    const nome = (r.headers.get("Content-Disposition") || "").match(/filename="([^"]+)"/)?.[1] || "arquivo";
    const blob = await r.blob();
    // Celular: abre a folha de compartilhar (salvar em Arquivos, WhatsApp, e-mail). Computador: download normal.
    const arquivo = new File([blob], nome, { type: blob.type });
    if (matchMedia("(pointer: coarse)").matches && navigator.canShare?.({ files: [arquivo] })) {
      try { await navigator.share({ files: [arquivo], title: nome }); return; }
      catch (e) { if (e.name === "AbortError") return; }
    }
    const link = URL.createObjectURL(blob);  // outro nome: "url" já é o parâmetro (endereço da API)
    if (navigator.standalone) { window.open(link, "_blank"); return; }  // app instalado no iPhone: abre o visualizador
    const a = Object.assign(document.createElement("a"), { href: link, download: nome });
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(link), 30000);
  } catch (err) { mostrarErro("Não foi possível gerar o arquivo: " + err.message); }
  finally { botao.disabled = false; botao.textContent = texto; }
}

async function recalcular() {
  if (!estado.setor) return;
  const corpo = pedidoAtual();
  const r = await fetch("/api/analisar", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(corpo) });
  if (!r.ok) return mostrarErro((await r.json()).detail || r.statusText);
  renderizar(await r.json());
}

function mostrarErro(msg) { const e = $("#erro"); e.textContent = msg; e.hidden = false; }

function renderizar(r) {
  estado.res = r;
  const id = r.identificacao, p = r.parametros, z = id.zona;
  $("#resultado").hidden = false;
  const cls = { "SIM": "sim", "NÃO": "nao", "A CONFIRMAR": "conf" }[r.veredito] || "conf";
  $("#veredito").className = "card veredito " + cls;
  $("#v-texto").textContent = r.veredito + (p.ilustrativo ? " (ilustrativo)" : "");
  $("#v-frase").textContent = r.frase;
  $("#v-nota").textContent = r.nota_veredito || "";
  $("#v-zona").innerHTML =
    `<div>Setor: <strong>${id.setor}</strong> · Quadra: <strong>${id.quadra}</strong>` + (id.distrito ? ` · ${esc(id.distrito)}` : "") + "</div>" +
    `<div>Zona <strong>${esc(z.sigla || "não identificada")}</strong>` +
    (z.sem_limite ? ` (Quadro 3: sem gabarito máximo; teste ilustrativo com ${num(p.gabarito_m, 1).replace(",0", "")} m)`
      : z.gabarito_m ? ` (Quadro 3: ${num(z.gabarito_m, 1).replace(",0", "")} m)` : " (sem gabarito cadastrado)") +
    ` · <span class="dica">Quadro 3 da Lei 16.402/2016, redação da Lei 18.081/2024</span>` +
    (z.origem ? ` · <span class="dica">${esc(z.origem)}</span>` : "") + "</div>";
  renderTabelaZonas(r);
  $("#criterio-texto").textContent = r.criterios_edificado[p.criterio_edificado] || p.criterio_edificado;

  $("#alertas").innerHTML = r.alertas.map((a) => `<div class="alerta ${a.nivel}"><span class="farol" aria-hidden="true"></span><span>${esc(a.texto)}</span></div>`).join("");
  if (r.estudo_nao_encontrado?.length) $("#estudo-aviso").textContent = `Não encontrado na quadra: ${r.estudo_nao_encontrado.join(", ")}.`;
  base("#base-iptu", "Via IPTU", "Áreas do cadastro fiscal (qt_area_terreno)", r.bases.iptu, p, z);
  base("#base-mdc", "Via MDC", "Áreas dos polígonos do Mapa Digital da Cidade", r.bases.mdc, p, z);
  tabela(r);
  desenharMapa();

  $("#validacoes").innerHTML = r.validacoes.map((v) =>
    `<li><span class="${v.ok === false ? "nok" : "ok"}">${v.ok === false ? "✗" : v.ok === null ? "?" : "✓"}</span> <strong>${esc(v.nome)}</strong>: ${esc(v.detalhe)}</li>`).join("");
  $("#fontes").innerHTML = r.fontes.map((f) =>
    `<li><strong>${esc(f.nome)}</strong>: ${f.erro ? `<span class="nok">${esc(f.erro)}</span>` :
      `${f.n_feicoes} feições · consultado em ${dataBR(f.consultado_em)}${f.do_cache ? " (cache)" : ""}`}` +
    (f.url ? `<br><small>${esc(f.url)}</small>` : "") + "</li>").join("");
  $("#legal").innerHTML = Object.entries(r.texto_legal).filter(([k]) => !k.startsWith("_")).map(([, t]) => `<li>${esc(t)}</li>`).join("") +
    `<li><small>${esc(r.texto_legal._obs || "")}</small></li>`;
  $("#limitacoes").innerHTML = r.limitacoes.map((t) => `<li>${esc(t)}</li>`).join("");
  $("#escopo").textContent = r.aviso_escopo;
}

// ------------------------------------------------------------ tabela do Quadro 3 (editável)
let tabelaGab = null;

async function renderTabelaZonas(r) {
  try {
    if (!tabelaGab) {
      const resp = await fetch("/api/gabaritos");
      if (!resp.ok) throw new Error((await resp.json().catch(() => ({}))).detail || resp.statusText);
      tabelaGab = await resp.json();
    }
  } catch (err) { $("#zonas-corpo").innerHTML = `<tr><td colspan="5" class="dica">Tabela indisponível: ${esc(err.message)}</td></tr>`; return; }
  const naQuadra = Object.keys(r.identificacao.zona.composicao || {});
  if (r.identificacao.zona.sigla && !naQuadra.includes(r.identificacao.zona.sigla)) naQuadra.push(r.identificacao.zona.sigla);
  const zonas = { ...tabelaGab.zonas };
  naQuadra.forEach((s) => { if (!zonas[s]) zonas[s] = { gabarito_m: "", confirmado: false, obs: "", nova: true }; });
  const ordem = Object.keys(zonas).sort((a, b) => (naQuadra.includes(b) - naQuadra.includes(a)) || a.localeCompare(b));
  $("#zonas-corpo").innerHTML = ordem.map((s) => {
    const z = zonas[s], sem = z.gabarito_m === null;
    return `<tr class="${naQuadra.includes(s) ? "na-quadra" : ""}${z.nova ? " nova" : ""}" data-zona="${esc(s)}">
      <td><strong>${esc(s)}</strong>${naQuadra.includes(s) ? ' <span class="dica">na quadra</span>' : ""}</td>
      <td><input type="number" step="0.5" min="0" max="300" class="z-gab" value="${sem ? "" : esc(z.gabarito_m)}" ${sem ? "disabled" : ""} aria-label="Gabarito de ${esc(s)} (m)"></td>
      <td><input type="checkbox" class="z-sem" ${sem ? "checked" : ""} aria-label="${esc(s)} sem limite"></td>
      <td><input type="checkbox" class="z-conf" ${z.confirmado ? "checked" : ""} aria-label="${esc(s)} confirmado"></td>
      <td><input type="text" class="z-obs" value="${esc(z.obs || "")}" aria-label="Observação de ${esc(s)}"></td></tr>`;
  }).join("");
  $("#zonas-corpo").querySelectorAll(".z-sem").forEach((c) => c.addEventListener("change", () => {
    const g = c.closest("tr").querySelector(".z-gab"); g.disabled = c.checked; if (c.checked) g.value = "";
  }));
}

$("#zonas-nova").addEventListener("click", () => {
  const s = ($("#zonas-sigla").value || "").trim();
  if (!/^[A-Za-z0-9-]{1,12}$/.test(s)) { $("#zonas-msg").textContent = "Sigla inválida (letras, números e hífen)."; return; }
  if (tabelaGab && !tabelaGab.zonas[s]) tabelaGab.zonas[s] = { gabarito_m: "", confirmado: false, obs: "" };
  $("#zonas-sigla").value = ""; if (estado.res) renderTabelaZonas(estado.res);
});

$("#zonas-salvar").addEventListener("click", async () => {
  const zonas = {};
  for (const tr of $("#zonas-corpo").querySelectorAll("tr[data-zona]")) {
    const s = tr.dataset.zona, sem = tr.querySelector(".z-sem").checked, v = tr.querySelector(".z-gab").value;
    if (!sem && v === "") continue;  // linha sugerida e não preenchida: não grava
    zonas[s] = { gabarito_m: sem ? null : parseFloat(v), confirmado: tr.querySelector(".z-conf").checked, obs: tr.querySelector(".z-obs").value };
  }
  const corpo = { ...tabelaGab, zonas, _editado_em: new Date().toISOString().slice(0, 10) };
  const r = await fetch("/api/gabaritos", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(corpo) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { $("#zonas-msg").textContent = "Não foi possível salvar: " + (j.detail || r.statusText); return; }
  tabelaGab = corpo; $("#zonas-msg").textContent = "Tabela salva. Resultado recalculado com os novos valores.";
  recalcular();
});

function base(sel, titulo, sub, b, p, z) {
  const g = num(p.gabarito_m, 1).replace(",0", "");
  // Gabarito e zona usados no teste (Quadro 3 da zona do terreno em estudo ou da predominante)
  const zona = z.gabarito_alterado ? "informado" : !z.sigla ? "zona não identificada"
    : (z.sem_limite || z.gabarito_m == null) ? `${z.sigla}, ilustrativo` : z.sigla;
  const acima = `Área edificada > ${g} m [${esc(zona)}]`;
  const corLei = { "SIM": "var(--ok)", "NÃO": "var(--sim)" }[b.veredito_lei] || "var(--conf)";
  $(sel).innerHTML = `<h2>${titulo}</h2><p class="sub">${sub}</p><dl>
    <dt data-tip="${esc(b.fonte_area_quadra)}">Área da quadra</dt><dd>${num(b.area_quadra, 2)} m²</dd>
    <dt data-tip="Soma das áreas dos lotes com prédio (condomínio CD ou altura ≥ 10 m).">Área edificada</dt><dd>${num(b.area_edificada, 2)} m²</dd>
    <dt data-tip="${esc(b.formulas.pct_edificada)}. Informativo: a lei não exige percentual mínimo de área edificada.">% Área edificada</dt><dd>${pct(b.pct_edificada)}</dd>
    <dt data-tip="Soma das áreas dos lotes inteiros (não a projeção do prédio) com edificação acima de ${g} m – art. 60, §1º.">${acima}</dt><dd>${num(b.area_acima, 2)} m²</dd>
    <dt data-tip="${esc(b.formulas.pct_lei)}. A lei exige mais de 50%.">% ${acima} (art. 60, II)</dt><dd style="color:${corLei}">${pct(b.pct_lei)} · ${b.veredito_lei}</dd>
  </dl>`;
  $(sel).querySelectorAll("[data-tip]").forEach((el) => el.title = el.dataset.tip);
}

const COLS = [
  ["id", "Lote"], ["zona", "Zona"], ["sql", "SQL"], ["endereco", "Endereço"], ["area_iptu", "Área IPTU (m²)"], ["area_mdc", "Área MDC (m²)"],
  ["diferenca_pct", "Dif. %"], ["altura_mdc", "Altura MDC (m)"], ["altura_legal", "Altura legal (m)"], ["situacao", "Acima do gabarito"],
  ["fonte_altura", "Fonte da altura"],
];

function tabela(r) {
  if (!r) return;
  const manual = !!estado.refManual;
  const cols = manual ? [...COLS, ["manual", `${esc(estado.refManual)} (m)`]] : COLS;
  $("#n-lotes").textContent = `(${r.lotes.length})`;
  $("#tabela thead").innerHTML = "<tr>" + cols.map(([k, t]) => `<th data-k="${k}">${t}</th>`).join("") + "</tr>";
  $("#tabela thead").querySelectorAll("th").forEach((th) => th.addEventListener("click", () => {
    const k = th.dataset.k; estado.ordem = estado.ordem?.k === k ? { k, d: -estado.ordem.d } : { k, d: 1 }; tabela(estado.res);
  }));
  let ls = [...r.lotes];
  if (estado.ordem) { const { k, d } = estado.ordem; ls.sort((a, b) => ((a[k] ?? -1e9) > (b[k] ?? -1e9) ? 1 : (a[k] ?? -1e9) < (b[k] ?? -1e9) ? -1 : 0) * d); }
  $("#tabela tbody").innerHTML = ls.map((l) => {
    const faixa = l.altura_legal_min != null && l.altura_legal_max != null && l.altura_legal_min !== l.altura_legal_max
      ? ` (${num(l.altura_legal_min, 1)} a ${num(l.altura_legal_max, 1)})` : "";
    const sit = l.situacao === "a_confirmar" ? `${l.tendencia === "sim" ? "Sim" : "Não"} (a confirmar)` : NOMES_SIT[l.situacao];
    const valor = estado.manuais[l.id]?.altura_m ?? "";
    const fonte = l.fonte_altura === "alvara" && l.referencia_altura ? l.referencia_altura : (FONTE_ALT[l.fonte_altura] || l.fonte_altura);
    return `<tr title="${esc(l.avisos.join(" "))}">
      <td>${esc(l.id)}</td><td>${esc(l.zona || "—")}</td><td>${esc(l.sql || (l.condominio ? "Condomínio " + l.condominio : "—"))}</td><td>${esc(l.endereco || "—")}</td>
      <td class="n">${num(l.area_iptu, 2)}</td><td class="n">${num(l.area_mdc, 2)}</td>
      <td class="n ${l.divergencia_relevante ? "div" : ""}">${l.diferenca_pct == null ? "—" : (l.diferenca_pct > 0 ? "+" : "") + num(l.diferenca_pct, 0) + "%"}</td>
      <td class="n">${num(l.altura_mdc, 1)}</td><td class="n">${num(l.altura_legal, 1)}${faixa}</td>
      <td><span class="tag ${l.situacao}">${sit}</span></td><td>${l.n_edificacoes ? esc(fonte) : "—"}</td>
      ${manual ? `<td>${l.n_edificacoes ? `<input type="number" step="0.1" min="0" data-lote="${esc(l.id)}" value="${valor}" aria-label="Altura de ${esc(l.id)} pela base ${esc(estado.refManual)}">` : ""}</td>` : ""}</tr>`;
  }).join("");
  $("#tabela tbody").querySelectorAll("input[data-lote]").forEach((inp) => inp.addEventListener("change", () => {
    const v = parseFloat(inp.value);
    if (isNaN(v)) delete estado.manuais[inp.dataset.lote];
    else estado.manuais[inp.dataset.lote] = { altura_m: v, referencia: estado.refManual };
    recalcular();
  }));
}

function copiarResumo() {
  const r = estado.res; if (!r) return;
  const b = r.bases, id = r.identificacao;
  const t = [
    `Quadra ${id.setor}-${id.quadra}${id.distrito ? " (" + id.distrito + ")" : ""} · Zona ${id.zona.sigla || "não identificada"} · gabarito ${num(r.parametros.gabarito_m, 1)} m${r.parametros.ilustrativo ? " (ilustrativo)" : ""}`,
    `QUEBRA DE GABARITO: ${r.veredito}`, r.frase, r.nota_veredito || "",
    ...[["IPTU", b.iptu], ["MDC", b.mdc]].map(([t, x]) => `${t}: quadra ${num(x.area_quadra, 2)} m² · edificada ${num(x.area_edificada, 2)} m² (${pct(x.pct_edificada)}) · edificada acima do gabarito ${num(x.area_acima, 2)} m² · art. 60, II: ${pct(x.pct_lei)} ${x.veredito_lei}`),
    r.aviso_escopo,
  ].filter(Boolean).join("\n");
  navigator.clipboard.writeText(t).then(() => { $("#copiar").textContent = "Copiado ✓"; setTimeout(() => $("#copiar").textContent = "Copiar resumo", 1500); });
}
