// src/api/watches.js
// El control plane de las vigilancias, proxeado: el HUD y el launcher hablan con el backend y el
// token de :8007 no sale de este proceso. Las tres rutas van detrás de `requireWatchAuth`
// (api/auth.js), que es MÁS estricto que el resto de la API: token aunque sea loopback y 403 a
// cualquier request con `Origin`. La razón está escrita ahí y es la del plan §9: una vigilancia
// es lo primero de este sistema que corre sin ninguna frase del usuario.
//
// Los errores los captura el wrapper `handler` del router (api/handler.js); acá solo se escribe
// la respuesta feliz y se traducen los códigos del sidecar.
import { config } from '../config.js';
import * as senseClient from '../pipeline/senseClient.js';
import * as senseBridge from '../pipeline/senseBridge.js';
import { armSensor, specFromFields } from '../pipeline/tools.js';

// La fila que sale del backend, campo por campo. El sidecar ya promete no mandar contenido
// observado, pero esta lista blanca es lo que lo GARANTIZA acá: si algún día su fila crece con un
// campo nuevo (una ruta, un host, la línea que casó), no se filtra por esta ruta sin que alguien
// lo escriba a mano. Tampoco sale `sessionId`: es un identificador interno de entrega y quien
// puede leer esta ruta no lo necesita para nada.
const publicRow = (w) => ({
  watchId: w.watchId, label: w.label, state: w.state, rung: w.rung, sensorKind: w.sensorKind,
  lastSampleAt: w.lastSampleAt ?? null, samplesOk: w.samplesOk ?? 0, samplesFailed: w.samplesFailed ?? 0,
  fires: w.fires ?? 0, expiresAt: w.expiresAt ?? null,
});

// Apagado y caído son el mismo estado observable para el cliente (mismo criterio que senseClient).
const offline = (res) => res.status(503).json({ error: 'sense_unavailable' });

/**
 * Mapea el error del sidecar al código HTTP. `reason` viaja TAL CUAL: en el 403 de una ruta
 * denegada esa frase es exactamente la que produce la negación del agente, y es la que el usuario
 * tiene que escuchar. Lo que no es del contrato (una caída, un apagado) sale como 503: no se
 * inventa un código para algo que no pasó del otro lado.
 */
function fail(res, r) {
  const status = [400, 403, 404, 409].includes(r.status) ? r.status : 503;
  return res.status(status).json({ error: r.error, reason: r.reason || '' });
}

export const listWatches = async (req, res) => {
  if (!config.sense.enabled) return offline(res);
  const r = await senseClient.listWatches();
  if (r.error) return fail(res, r);
  res.status(200).json({ watches: (r.watches || []).map(publicRow) });
};

/**
 * POST { label, sensor: { kind, ...campos por nombre } }. El spec se RECONSTRUYE desde el
 * catálogo de sensores (tools.js), no se reenvía: así este cuerpo nunca puede ser una cadena de
 * comando ni un objeto con campos que el backend no entiende (regla R2 del plan).
 */
export const createWatch = async (req, res) => {
  if (!config.sense.enabled) return offline(res);
  const parsed = specFromFields(req.body?.sensor);
  if (parsed.error) return res.status(400).json({ error: 'invalid request', reason: parsed.error });
  // Sin sessionId: una vigilancia armada por REST nace sin dueño, y lo que dispare va al buzón
  // hasta que alguien conecte un HUD. Inventarle una sesión sería elegir a quién hablarle.
  const r = await armSensor(null, parsed.sensor, req.body?.label);
  if (r.error) return fail(res, r);
  res.status(201).json({ watchId: r.watchId });
};

export const deleteWatch = async (req, res) => {
  if (!config.sense.enabled) return offline(res);
  const r = await senseBridge.disarm(req.params.id);
  if (r.error) return fail(res, r);
  res.status(200).json({ disarmed: true });
};
