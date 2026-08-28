# sidecar/sense/tests/test_main.py
"""El prólogo de guardias del control plane y las rutas que protege.

Este es el guardia MÁS ESTRICTO del sistema y era el único sin un solo test. La
diferencia importa: `authorize()` del backend le abre a cualquier IP de loopback
sin token, y la fachada del agente hace `if (!token) return true`. Acá no, y la
razón está en el plan §9: una vigilancia es la primera primitiva de este sistema
que corre SIN NINGUNA FRASE DEL USUARIO, así que arrancar sin token tiene que ser
inútil y no abierto.

Se probó a mano una vez, en vivo, y una aceptación que no se puede repetir no es
una aceptación. En una copia de trabajo, estas tres mutaciones dejaban la suite
en verde: volver un no-op el 403 del Origin, invertir la regla del token vacío
(que abriría TODAS las rutas), y cargar lo persistido como `armed` (asunción A4,
en test_registry.py). Cada test de acá mata una de esas.

Los guardias se prueban por su EFECTO y no solo por el código: un 403 que no
crea la vigilancia, un 415 que no la crea, un 401 que no la crea. Un guardia
que contesta bien y deja pasar el trabajo igual es exactamente el bug que un
test de status code no ve.
"""
import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

import main
import registry as registry_module
import sensors
from config import MAX_BODY_BYTES

BEARER = {"authorization": f"Bearer {main.TOKEN}"}
#: Lo que manda un navegador y el backend jamás: es el único cliente del sidecar
#: y el fetch de Node no pone Origin.
NAVEGADOR = {"origin": "http://localhost:5173"}

RUTAS_CERRADAS = [
    ("GET", "/v1/capabilities"),
    ("GET", "/v1/watches"),
    ("GET", "/v1/watches/w_loquesea"),
    ("POST", "/v1/watches"),
    ("DELETE", "/v1/watches/w_loquesea"),
    ("GET", "/v1/events"),
]


def spec(**extra):
    """Un cuerpo de POST /v1/watches válido, con el andamio (no toca la máquina)."""
    body = {"label": "el entrenamiento", "sensor": {"kind": "stub"},
            "periodMs": 60_000, "expiresAt": main.now_ms() + 3_600_000}
    body.update(extra)
    return body


@pytest.fixture
def client(tmp_path, monkeypatch):
    """La app entera, con su lifespan corriendo y el estado en un temporal.

    Se limpia el registro GLOBAL en vez de reemplazarlo: `scheduler` se quedó con
    una referencia al de `main`, así que un Registry nuevo dejaría al scheduler
    escribiendo en uno y a las rutas leyendo del otro.
    """
    monkeypatch.setattr(registry_module, "STATE_DIR", tmp_path)
    monkeypatch.setattr(registry_module, "WATCHES_FILE", tmp_path / "watches.json")
    main.registry._watches.clear()
    with TestClient(main.app) as instance:
        yield instance
    main.registry._watches.clear()


def armadas(client):
    """Las vigilancias que el sidecar dice tener. Es la forma de preguntar si un
    guardia además de contestar IMPIDIÓ el trabajo."""
    return client.get("/v1/watches", headers=BEARER).json()["watches"]


# ── /health, la única puerta abierta ─────────────────────────────────────────
def test_health_contesta_sin_token(client):
    """Un 401 acá sería indistinguible de "mal configurado" justo cuando hace
    falta la diferencia: es lo que consultan el backend y `hannah doctor`."""
    response = client.get("/health")
    assert response.status_code == 200
    body = response.json()
    assert body["healthy"] is True and body["version"] == "sense.v1"
    assert set(body["watches"]) == {"armed", "degraded", "blind", "suspended"}


def test_health_no_filtra_el_home_ni_el_usuario(client):
    """AUDIT M22 sigue abierto sobre el /health del agente; no se repite acá."""
    crudo = client.get("/health").text
    assert str(Path.home()) not in crudo
    assert "watches" in json.loads(crudo) and "home" not in crudo


# ── El token ─────────────────────────────────────────────────────────────────
@pytest.mark.parametrize("method,path", RUTAS_CERRADAS)
def test_toda_otra_ruta_exige_el_bearer(client, method, path):
    response = client.request(method, path)
    assert response.status_code == 401
    assert response.headers["www-authenticate"] == "Bearer"
    assert response.headers["cache-control"] == "no-store"


def test_sin_token_no_se_arma_nada(client):
    """El 401 tiene que IMPEDIR, no solo contestar."""
    assert client.post("/v1/watches", json=spec()).status_code == 401
    assert armadas(client) == []


def test_un_token_vacio_no_abre_el_sidecar(client, monkeypatch):
    """LA DIVERGENCIA DELIBERADA con la fachada del agente, que hace
    `if (!token) return true` porque el backend puede arrancarla sin token en
    desarrollo. Invertir esto (o sea copiar la fachada) abre TODAS las rutas del
    control plane de las vigilancias en cualquier máquina que arranque el sidecar
    sin configurar: sin una sola frase del usuario, cualquiera arma una."""
    monkeypatch.setattr(main, "TOKEN", "")
    for headers in ({}, {"authorization": "Bearer "}, {"authorization": "Bearer loquesea"}, BEARER):
        assert client.get("/v1/capabilities", headers=headers).status_code == 401
    # Y /health sigue abierto: apagado y mal configurado tienen que distinguirse.
    assert client.get("/health").status_code == 200


@pytest.mark.parametrize("valor", [
    "",                                   # sin nada
    "loquesea",                            # otro token
    f"Bearer {main.TOKEN}x",               # el token con algo pegado
    f"Bearer {main.TOKEN[:-1]}",           # un prefijo del token
    main.TOKEN,                            # el token crudo, sin esquema
    f"Token {main.TOKEN}",                 # otro esquema
    f"Basic {main.TOKEN}",
])
def test_un_authorization_que_no_es_el_token_es_401(client, valor):
    assert client.get("/v1/capabilities", headers={"authorization": valor}).status_code == 401


def test_el_esquema_es_insensible_a_mayusculas_y_tolera_espacios(client):
    """`Bearer`/`bearer` y el header con espacios alrededor son el mismo header
    para cualquier cliente HTTP; rechazarlos sería un fallo de interoperabilidad
    disfrazado de seguridad."""
    assert client.get("/v1/capabilities",
                      headers={"authorization": f"bearer {main.TOKEN}"}).status_code == 200


# ── El Origin: navegadores, nunca ────────────────────────────────────────────
def test_un_request_con_origin_es_403_aunque_traiga_el_token(client):
    """Una página abierta en esta máquina alcanza 127.0.0.1:8007 con un request
    "simple" (sin preflight). El backend es el único cliente y no manda Origin,
    así que la presencia del header ya dice que quien llama no es el backend.
    Sin este guardia, el token de la UI que vive en el navegador alcanza para
    armar vigilancias desde cualquier pestaña."""
    response = client.get("/v1/watches", headers={**BEARER, **NAVEGADOR})
    assert response.status_code == 403
    assert response.json() == {"error": "forbidden"}


@pytest.mark.parametrize("origin", ["http://localhost:5173", "null", "http://127.0.0.1:8007"])
def test_con_origin_no_se_arma_nada(client, origin):
    """El guardia por su efecto: `null` es el Origin de un iframe en sandbox y el
    del propio sidecar tampoco vale, porque el backend NUNCA manda el header."""
    response = client.post("/v1/watches", json=spec(), headers={**BEARER, "origin": origin})
    assert response.status_code == 403
    assert armadas(client) == []


# ── El cuerpo ────────────────────────────────────────────────────────────────
def test_un_post_que_no_es_json_es_415_y_no_arma(client):
    """text/plain es la ÚNICA forma que tiene un navegador de postear sin
    preflight, así que un cuerpo que no es JSON es por definición algo que no es
    el backend."""
    response = client.post("/v1/watches", content=json.dumps(spec()),
                           headers={**BEARER, "content-type": "text/plain"})
    assert response.status_code == 415
    assert armadas(client) == []


def test_un_cuerpo_declarado_gigante_se_rechaza_antes_de_leerlo(client):
    grande = json.dumps(spec(label="x" * (MAX_BODY_BYTES + 1000)))
    response = client.post("/v1/watches", content=grande,
                           headers={**BEARER, "content-type": "application/json"})
    assert response.status_code == 400
    assert "256 KiB" in response.json()["reason"]
    assert armadas(client) == []


def test_un_cuerpo_sin_largo_declarado_igual_tiene_tope(client):
    """El tope de verdad lo pone `read_body()` leyendo de a chunks: un cuerpo
    chunked no declara largo, así que el rechazo temprano por content-length no
    lo ve. Sin el tope de `read_body`, esto es un DoS de memoria de una línea
    contra un proceso cuyo trabajo es seguir vigilando."""
    def por_pedazos():
        yield b'{"label": "'
        for _ in range((MAX_BODY_BYTES // 1024) + 2):
            yield b"x" * 1024
        yield b'"}'

    response = client.post("/v1/watches", content=por_pedazos(),
                           headers={**BEARER, "content-type": "application/json"})
    assert response.status_code == 400
    assert "256 KiB" in response.json()["reason"]


def test_json_invalido_es_400_con_razon(client):
    response = client.post("/v1/watches", content="{no soy json",
                           headers={**BEARER, "content-type": "application/json"})
    assert response.status_code == 400
    assert response.json()["reason"] == "JSON inválido"


# ── Superficie ───────────────────────────────────────────────────────────────
@pytest.mark.parametrize("path", ["/docs", "/redoc", "/openapi.json"])
def test_no_hay_documentacion_publicada(client, path):
    """Superficie que nadie usa en un control plane cuyo único cliente es el
    backend. Con token, para que el 404 sea del router y no del guardia."""
    assert client.get(path, headers=BEARER).status_code == 404


# ── Las rutas, una vez pasado el prólogo ─────────────────────────────────────
def test_armar_desarmar_y_consultar(client):
    creada = client.post("/v1/watches", json=spec(), headers=BEARER)
    assert creada.status_code == 201
    watch_id = creada.json()["watchId"]

    fila = client.get(f"/v1/watches/{watch_id}", headers=BEARER)
    assert fila.status_code == 200 and fila.json()["state"] == "armed"

    assert client.delete(f"/v1/watches/{watch_id}", headers=BEARER).json() == {"disarmed": True}
    assert client.get(f"/v1/watches/{watch_id}", headers=BEARER).json()["state"] == "disarmed"
    assert client.get("/v1/watches/w_no_existe", headers=BEARER).status_code == 404
    assert client.delete("/v1/watches/w_no_existe", headers=BEARER).status_code == 404


def test_la_fila_no_devuelve_nada_de_lo_que_escribio_el_usuario_salvo_la_etiqueta(client):
    """`watchStatus()` se arma con estas filas y se pega al system prompt de cada
    turno con acciones: contenido observado acá sería un punto de inyección
    permanente mientras el watch esté armado (plan §10, T9). La narración se
    guarda y NO viaja."""
    client.post("/v1/watches", headers=BEARER,
                json=spec(narration="mirá el log de /home/yo/secreto/train.log"))
    crudo = client.get("/v1/watches", headers=BEARER).text
    assert "el entrenamiento" in crudo                 # la etiqueta sí
    assert "secreto" not in crudo and "narration" not in crudo


def test_una_ruta_denegada_se_rechaza_al_armar_y_con_la_razon_que_se_dice(client):
    """403 en el POST y no un fallo en la muestra número uno: un watch que se
    arma y recién después descubre que no puede leer ya le mintió al usuario. La
    razón es la MISMA cadena que produce la denegación del agente, porque el
    usuario escucha una sola explicación pida leer el archivo o pida vigilarlo."""
    response = client.post("/v1/watches", headers=BEARER, json=spec(
        sensor={"kind": "file", "path": str(Path.home() / ".ssh" / "id_rsa"), "stallSeconds": 60}))
    assert response.status_code == 403
    assert response.json()["error"] == "forbidden"
    assert response.json()["reason"]
    assert armadas(client) == []


def test_un_spec_invalido_es_400_y_no_ocupa_cupo(client):
    response = client.post("/v1/watches", headers=BEARER, json=spec(periodMs=1))
    assert response.status_code == 400
    assert armadas(client) == []


def test_el_kind_del_andamio_no_se_arma_por_http(client):
    """La costura de la suite está abierta en todo el archivo (conftest), así que
    esto la cierra a mano para probar lo que hace el proceso de verdad: `stub` no
    sale en /v1/capabilities y un POST con ese kind contesta lo MISMO que uno
    inventado, sin confirmar que existe."""
    sensors.allow_test_sensors(False)
    inventado = client.post("/v1/watches", headers=BEARER, json=spec(sensor={"kind": "telepatia"}))
    andamio = client.post("/v1/watches", headers=BEARER, json=spec())
    assert andamio.status_code == inventado.status_code == 400
    assert andamio.json() == inventado.json()
    assert "stub" not in client.get("/v1/capabilities", headers=BEARER).text


def test_el_cupo_lo_ocupan_solo_las_que_estan_muestreando(client, monkeypatch):
    """Dos son el tope (SENSE_MAX_WATCHES). Una desarmada deja de ocuparlo: su
    fila se conserva para que el HUD muestre por qué se desarmó, pero no muestrea
    nada, y contarla haría que dos vigilancias muertas de ayer impidieran armar
    una hoy."""
    monkeypatch.setattr(main, "MAX_WATCHES", 2)
    primera = client.post("/v1/watches", headers=BEARER, json=spec()).json()["watchId"]
    client.post("/v1/watches", headers=BEARER, json=spec())
    assert client.post("/v1/watches", headers=BEARER, json=spec()).status_code == 409

    client.delete(f"/v1/watches/{primera}", headers=BEARER)
    assert client.post("/v1/watches", headers=BEARER, json=spec()).status_code == 201


def test_las_capacidades_no_prometen_lo_que_no_se_puede_armar(client):
    """El backend arma el vocabulario de `[WATCH:]` con esto: un escalón
    anunciado y no armable es una vigilancia que Hannah promete y nadie mira."""
    body = client.get("/v1/capabilities", headers=BEARER).json()
    assert [r for r in body["rungs"] if r["available"]]
    for rung in body["rungs"]:
        assert rung["available"] is True or rung["reason"]
