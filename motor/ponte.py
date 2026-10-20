"""Ponte da versão HTML: roda dentro do navegador (Pyodide, num Web Worker) e faz o papel do
servidor (app/main.py) chamando o mesmo motor Python (pipeline, cálculo, mapa, planilha, relatório).

Diferenças em relação ao servidor, todas por limitação do navegador:
* rede: o GeoSampa não autoriza leitura direta pelo navegador (CORS), então as consultas passam por
  um repassador (relay) que só encaminha os dados; os endereços registrados nas fontes continuam os
  do GeoSampa;
* LiDAR: a folha é lida pelo laz-perf (WebAssembly) em vez do laspy, já recortada à quadra + 30 m;
  depois do recorte a folha é apagada (só o recorte da quadra fica guardado no aparelho);
* sem threads: as folhas são baixadas uma de cada vez;
* cache e tabela do Quadro 3 editada ficam no navegador de cada pessoa (IndexedDB), não são
  compartilhados com a equipe.
"""
from __future__ import annotations

import json
import os
import shutil
import sys
import zipfile
from datetime import date
from pathlib import Path

PERSISTENTE = Path("/persist")
GABARITOS_EDITADOS = PERSISTENTE / "gabaritos.json"

zipfile.ZipFile("/calc.zip").extractall("/calc")
sys.path.insert(0, "/calc")
os.environ["CALCGABARITO_CACHE"] = str(PERSISTENTE / "cache")

import pyodide_http  # noqa: E402

pyodide_http.patch_all()

import requests  # noqa: E402

from app import config, geosampa, lidar, pipeline  # noqa: E402
from app.modelo import normalizar_entrada  # noqa: E402

_REPASSE: dict[str, str] = {}
_request_original = requests.Session.request


def _request(self, method, url, *args, **kwargs):
    for original, novo in _REPASSE.items():
        if url.startswith(original):
            url = novo + url[len(original):]
            break
    return _request_original(self, method, url, *args, **kwargs)


requests.Session.request = _request


class _EmSequencia:
    """Substitui o ThreadPoolExecutor: o navegador não tem threads para o Python."""

    def __init__(self, *args, **kwargs):
        pass

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def map(self, funcao, itens):
        return [funcao(i) for i in itens]


def _ler_recorte_navegador(arq: Path, tipo: str, caixa: tuple):
    import js
    import numpy as np
    x0, y0, x1, y1 = caixa
    colunas = 4 if tipo == "MDS" else 3
    try:
        r = js.lazRecorte(str(arq), tipo == "MDS", x0, y0, x1, y1)
        pts = np.frombuffer(r.to_py(), dtype=np.float64).reshape(-1, colunas).copy()
    finally:
        Path(arq).unlink(missing_ok=True)  # a folha inteira (40 MB) não fica guardada no aparelho
    return pts


lidar.ThreadPoolExecutor = _EmSequencia
lidar._ler_recorte = _ler_recorte_navegador


_PRE: dict = {"site": "", "quadras": {}}


def iniciar(relay: str, site: str = "") -> str:
    """relay: endereço do repassador; site: endereço do site (para as quadras pré-carregadas).
    Devolve a versão do Python."""
    relay = relay.rstrip("/")
    _PRE["sem_relay"] = relay.endswith("/nenhum")
    _PRE["site"] = site if site.endswith("/") else site + "/"
    try:
        r = requests.get(_PRE["site"] + "motor/cache_indice.json", timeout=30)
        _PRE["quadras"] = r.json().get("quadras", {}) if r.ok else {}
    except Exception:  # sem índice o app segue normalmente, consultando o GeoSampa
        _PRE["quadras"] = {}
    _REPASSE.clear()
    _REPASSE["https://wfs.geosampa.prefeitura.sp.gov.br/geoserver/"] = relay + "/geosampa/wfs/"
    _REPASSE["https://download.geosampa.prefeitura.sp.gov.br/PaginasPublicas/"] = relay + "/geosampa/download/"
    if GABARITOS_EDITADOS.exists():
        shutil.copy(GABARITOS_EDITADOS, config.CONFIG_DIR / "gabaritos.json")
    return sys.version.split()[0]


class ErroAPI(Exception):
    def __init__(self, status: int, detalhe: str):
        super().__init__(detalhe)
        self.status, self.detalhe = status, detalhe


def _pre_carregar(s: str, q: str) -> None:
    """Se a quadra vem pré-carregada no site e ainda não está no cache deste navegador, copia o pacote
    (respostas do GeoSampa com a data da consulta + recorte do LiDAR) para o cache. Falha aqui não é erro:
    o app consulta o GeoSampa normalmente."""
    item = _PRE["quadras"].get(f"{s}-{q}")
    recorte = lidar.CACHE / f"recorte_{s}_{q}.npz"
    if not item and not recorte.exists() and _PRE.get("sem_relay"):
        prontas = ", ".join(sorted(_PRE["quadras"])) or "nenhuma"
        raise ErroAPI(503, "Esta versão ainda não está ligada ao GeoSampa (falta o repassador). "
                           f"Por enquanto funcionam só as quadras pré-carregadas: {prontas}.")
    if not item or recorte.exists():
        return
    try:
        import io
        r = requests.get(f'{_PRE["site"]}motor/cache/{item["arquivo"]}?v={item["versao"]}', timeout=300)
        r.raise_for_status()
        with zipfile.ZipFile(io.BytesIO(r.content)) as z:
            linhas = json.loads(z.read("wfs.json"))
            with geosampa._db() as con:
                con.executemany("INSERT OR IGNORE INTO wfs VALUES (?,?,?)",
                                [(u, d, c) for u, (d, c) in linhas.items()])
            recorte.parent.mkdir(parents=True, exist_ok=True)
            recorte.write_bytes(z.read(recorte.name))
    except Exception as e:
        print("Quadra pré-carregada indisponível:", type(e).__name__, e)


def _sq(setor, quadra, sql=None):
    try:
        return normalizar_entrada(setor, quadra, sql)
    except ValueError as e:
        raise ErroAPI(422, str(e))


def _resultado(p: dict) -> dict:
    s, q = _sq(p.get("setor"), p.get("quadra"), p.get("sql"))
    _pre_carregar(s, q)
    dados = pipeline.coletar(s, q, usar_cache=not p.get("recarregar"))
    return pipeline.analisar(dados, p.get("gabarito_m"), p.get("criterio_edificado"),
                             p.get("altura_minima_edificado_m"), p.get("alturas_manuais"), p.get("estudo"))


def _nome(r: dict, ext: str) -> str:
    i = r["identificacao"]
    return f'quebra-gabarito_{i["setor"]}-{i["quadra"]}_{date.today():%Y-%m-%d}.{ext}'


def _json(dado) -> str:
    return json.dumps(dado, ensure_ascii=False, default=str)


def analisar_stream(setor, quadra, recarregar, emitir) -> None:
    """Mesma análise do /api/analisar/stream: emitir(tipo, json) para cada etapa e no fim."""
    try:
        s, q = _sq(setor, quadra)
        _pre_carregar(s, q)
        dados = pipeline.coletar(s, q, usar_cache=not recarregar, progresso=lambda e: emitir("etapa", _json(e)))
        emitir("etapa", _json("calculo"))
        emitir("resultado", _json(pipeline.analisar(dados)))
    except ErroAPI as e:
        emitir("erro", _json(e.detalhe))
    except Exception as e:  # nunca deixar o usuário sem resposta
        emitir("erro", _json(f"{type(e).__name__}: {e}"))


def api(metodo: str, caminho: str, corpo: str | None):
    """Equivalente às rotas de app/main.py. Devolve dict:
    {"status", "json"} ou {"status", "bytes", "tipo", "nome"} ou {"status", "html", "nome"}."""
    try:
        p = json.loads(corpo) if corpo else {}
        if caminho == "/api/analisar" and metodo == "POST":
            return {"status": 200, "json": _json(_resultado(p))}
        if caminho == "/api/planilha.xlsx" and metodo == "POST":
            from app.planilha import gerar_xlsx
            r = _resultado(p)
            return {"status": 200, "bytes": gerar_xlsx(r), "nome": _nome(r, "xlsx"),
                    "tipo": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"}
        if caminho == "/api/relatorio.html" and metodo == "POST":
            from app.relatorio import html_relatorio
            r = _resultado(p)
            # Mesmas tentativas de app/relatorio.gerar_pdf (compacto, linhas da tabela); a tela mede as páginas.
            html = html_relatorio(r, bool(p.get("_compacto")), p.get("_max_linhas"), motor="navegador")
            return {"status": 200, "html": html, "nome": _nome(r, "pdf")}
        if caminho == "/api/gabaritos" and metodo == "GET":
            return {"status": 200, "json": _json(config.gabaritos())}
        if caminho == "/api/gabaritos" and metodo == "PUT":
            try:
                tabela = config.validar_gabaritos(p)
            except ValueError as e:
                raise ErroAPI(422, str(e))
            config.salvar_gabaritos(tabela)
            PERSISTENTE.mkdir(parents=True, exist_ok=True)
            shutil.copy(config.CONFIG_DIR / "gabaritos.json", GABARITOS_EDITADOS)
            return {"status": 200, "json": _json({"ok": True, "zonas": len(tabela["zonas"])})}
        if caminho == "/api/cache/limpar" and metodo == "POST":
            pipeline._memoria.clear()
            return {"status": 200, "json": _json({"removidos": geosampa.limpar_cache()})}
        raise ErroAPI(404, f"Função não disponível na versão HTML: {metodo} {caminho}")
    except ErroAPI as e:
        return {"status": e.status, "json": _json({"detail": e.detalhe})}
    except Exception as e:
        return {"status": 500, "json": _json({"detail": f"{type(e).__name__}: {e}"})}
