// backend/indexing.mjs
import { create } from "ipfs-http-client";

/**
 * ------------------------------------------------------------------
 *  Configuración de endpoints IPFS (cluster proxy con failover)
 * ------------------------------------------------------------------
 *
 * IPFS_ENDPOINTS  = "http://192.168.1.194:9095,http://192.168.1.193:9095,..."
 * IPFS_API_URL    = fallback viejo (un solo nodo)
 */
export const IPFS_ENDPOINTS = (
  process.env.IPFS_ENDPOINTS ||
  process.env.IPFS_API_URL ||
  "http://127.0.0.1:5001"
)
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

export const IPFS_INDEX_IPNS_KEY = process.env.IPFS_INDEX_IPNS_KEY?.trim();

if (!IPFS_ENDPOINTS.length) {
  console.warn("[IPFS] No hay endpoints configurados, usando http://127.0.0.1:5001");
  IPFS_ENDPOINTS.push("http://127.0.0.1:5001");
}

function createClient(baseUrl) {
  const url = baseUrl.replace(/\/+$/, "") + "/api/v0";
  return create({ url });
}

/* ------------------------------------------------------------------
 *  Cliente genérico con failover (LECTURA / CONTENIDO)
 * ------------------------------------------------------------------ */

/**
 * Ejecuta una operación IPFS "normal" (no streaming) con failover.
 * Ej: add, pin.add, name.resolve, etc.
 */
async function withIpfs(fn) {
  let lastErr;
  for (const base of IPFS_ENDPOINTS) {
    try {
      const client = createClient(base);
      return await fn(client, base);
    } catch (e) {
      lastErr = e;
      console.error("[IPFS] endpoint falló:", base, "-", e?.message || String(e));
    }
  }
  throw lastErr || new Error("Todos los endpoints IPFS fallaron");
}

/**
 * cat con failover: devuelve un async iterator de chunks.
 * Se usa para leer CIDs (/ipfs/<cid>...) desde cualquier nodo vivo.
 */
async function* catWithFailover(cid, opts) {
  console.log(`[IPFS] catWithFailover iniciado para CID: ${cid}`);
  console.log(`[IPFS] Endpoints disponibles: ${IPFS_ENDPOINTS.length}`, IPFS_ENDPOINTS);

  let lastErr;
  for (let i = 0; i < IPFS_ENDPOINTS.length; i++) {
    const base = IPFS_ENDPOINTS[i];
    try {
      console.log(`[IPFS] Intentando cat ${i + 1}/${IPFS_ENDPOINTS.length} en: ${base}`);
      const client = createClient(base);

      let chunkCount = 0;
      for await (const chunk of client.cat(cid, opts)) {
        chunkCount++;
        yield chunk;
      }
      console.log(`[IPFS] ✅ cat exitoso en ${base} (${chunkCount} chunks)`);
      return; // terminó bien
    } catch (e) {
      lastErr = e;
      console.error(`[IPFS] cat falló en: ${base} - ${e?.message || String(e)}`);
      console.error(`[IPFS] Stack:`, e?.stack);

      // Si es el último, throw
      if (i === IPFS_ENDPOINTS.length - 1) {
        console.error(`[IPFS] ❌ Todos los endpoints (${IPFS_ENDPOINTS.length}) fallaron en cat()`);
        throw lastErr;
      }

      console.log(`[IPFS] → Probando siguiente endpoint...`);
      continue;
    }
  }
  throw lastErr || new Error("Todos los endpoints IPFS fallaron en cat()");
}

/**
 * files.read con failover: async iterator de chunks.
 * (Ahora lo usamos poco; el índice se lee casi siempre via /ipfs/<rootCid>.)
 */
async function* readWithFailover(path, opts) {
  let lastErr;
  for (const base of IPFS_ENDPOINTS) {
    try {
      const client = createClient(base);
      for await (const chunk of client.files.read(path, opts)) {
        yield chunk;
      }
      return;
    } catch (e) {
      lastErr = e;
      console.error("[IPFS] files.read falló en:", base, "-", e?.message || String(e));
      continue;
    }
  }
  throw lastErr || new Error("Todos los endpoints IPFS fallaron en files.read()");
}

/**
 * Objeto IPFS orientado a CONTENIDO:
 *  - add: subir PDFs, etc. (cluster se encarga de replicar el pin)
 *  - cat: leer CIDs
 *
 * OJO: las operaciones de MFS del índice (/cert-index) ya NO usan esto,
 * sino el writer flotante definido más abajo.
 */
const ipfsFailover = {
  add: (data, opts) => withIpfs(async (c) => {
    const result = await c.add(data, opts);
    // Si devuelve un async iterable (v50+), consumirlo para obtener el objeto final
    if (result && result[Symbol.asyncIterator]) {
      let last;
      for await (const item of result) {
        last = item;
      }
      return last;
    }
    return result;
  }),
  cat: (cid, opts) => catWithFailover(cid, opts),
  files: {
    // sólo lectura con failover, por si lo necesitas en alguna otra parte
    read: (path, opts) => readWithFailover(path, opts),
  },
};

/* ------------------------------------------------------------------
 *  Writer flotante para MFS /cert-index
 * ------------------------------------------------------------------ */

let currentWriter = null;  // { client, base }
let lastSyncedCid = null;  // último rootCid con el que sincronizamos /cert-index

/**
 * Busca un nodo IPFS disponible consultando TODOS en paralelo.
 * OPTIMIZADO: Usa Promise.race para obtener el primero que responda.
 */
async function pickWriter() {
  console.log(`[IPFS-Writer] Buscando nodo disponible entre ${IPFS_ENDPOINTS.length} opciones...`);

  // Crear promesas para todos los nodos en paralelo
  const promises = IPFS_ENDPOINTS.map(async (base) => {
    try {
      const client = createClient(base);
      // Timeout de 2 segundos por nodo
      await Promise.race([
        client.id(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 2000))
      ]);
      return { client, base, success: true };
    } catch (e) {
      console.warn(`[IPFS-Writer] ${base} no disponible: ${e?.message || String(e)}`);
      return { base, success: false, error: e };
    }
  });

  // Esperar a que al menos uno responda
  const results = await Promise.all(promises);

  // Buscar el primer nodo exitoso
  const winner = results.find(r => r.success);

  if (winner) {
    currentWriter = { client: winner.client, base: winner.base };
    console.log(`[IPFS-Writer] ✅ usando ${winner.base} como writer MFS`);
    return currentWriter;
  }

  // Si ninguno funcionó
  const errorMsg = `No hay writer IPFS disponible. Probados: ${IPFS_ENDPOINTS.join(', ')}`;
  console.error(`[IPFS-Writer] ❌ ${errorMsg}`);
  throw new Error(errorMsg);
}

async function getWriter() {
  if (currentWriter) {
    try {
      // si el writer actual sigue vivo, lo reutilizamos
      await currentWriter.client.id();
      return currentWriter;
    } catch (e) {
      console.warn("[IPFS-Writer] writer actual cayó, buscando otro...", e?.message || String(e));
      currentWriter = null;
    }
  }
  return pickWriter();
}

/**
 * Asegura que /cert-index existe en el writer actual.
 * SIMPLIFICADO: Systemd maneja la sincronización IPNS al inicio del nodo.
 * Esta función solo verifica que el índice exista.
 */
async function ensureIndexMfsSyncedForWriter() {
  const { client, base } = await getWriter();

  // Solo asegurar que /cert-index existe
  // La sincronización IPNS la maneja systemd al inicio
  try {
    await client.files.stat("/cert-index");
    // Índice existe, todo bien
  } catch (e) {
    const msg = e?.message || String(e || "");
    if (/does not exist|no such file/i.test(msg)) {
      // Crear estructura básica si no existe
      await client.files.mkdir("/cert-index", { parents: true });
      await client.files.mkdir("/cert-index/by-hash", { parents: true });
      await client.files.mkdir("/cert-index/by-owner", { parents: true });
      console.log("[MFS] ✅ /cert-index creado en", base);
    } else {
      console.warn("[MFS] stat /cert-index falló en", base, "-", msg);
    }
  }

  return { client, base };
}

/* ------------------------------------------------------------------
 *  Helpers de nombres / sharding para índices
 * ------------------------------------------------------------------ */

/**
 * Normaliza el nombre del dueño para indexar:
 * - trim
 * - mayúsculas
 * - colapsa espacios
 */
function normalizeOwnerName(name) {
  if (!name) return "";
  return String(name)
    .normalize("NFD")                 // separa acentos
    .replace(/[\u0300-\u036f]/g, "")  // quita diacríticos
    .toUpperCase()
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * shardPrefix: para /cert-index/by-hash/<SHARD>/<HASH>.json
 * Usa los 2 primeros chars del hash (si hay).
 */
function shardPrefix(hash) {
  const h = (hash || "").toLowerCase().replace(/[^0-9a-f]/g, "");
  if (h.length < 2) return "00";
  return h.slice(0, 2);
}

/**
 * keyPrefixFromOwner:
 * prefijo estable para agrupar dueños en carpetas /by-owner/<PREFIX>/<OWNER>.json
 * Tomamos:
 *  - primera letra (A-Z o "_")
 */
function keyPrefixFromOwner(ownerNorm) {
  if (!ownerNorm) return "_";
  const c = ownerNorm[0];
  return /[A-Z]/.test(c) ? c : "_";
}

/* ------------------------------------------------------------------
 *  Helpers MFS: asegurar dirs, leer/escribir JSON, mover (siempre en writer)
 * ------------------------------------------------------------------ */

async function ensureMfsDirs(paths) {
  const { client } = await ensureIndexMfsSyncedForWriter();
  for (const p of paths) {
    const clean = p.replace(/\/+$/, "");
    if (!clean) continue;
    try {
      await client.files.mkdir(clean, { parents: true });
    } catch (e) {
      const msg = e?.message || String(e || "");
      if (!/file exists/i.test(msg) && !/already exists/i.test(msg)) {
        console.warn("[MFS] mkdir falló para", clean, "-", msg);
      }
    }
  }
}

/**
 * Lee un JSON desde MFS, o devuelve null si no existe.
 * Siempre usa el writer flotante (ya sincronizado con IPNS si aplica).
 */
async function mfsReadJsonOrNull(path) {
  const { client } = await ensureIndexMfsSyncedForWriter();
  try {
    const chunks = [];
    for await (const c of client.files.read(path)) {
      chunks.push(c);
    }
    const buf = Buffer.concat(chunks);
    if (!buf.length) return null;
    return JSON.parse(buf.toString("utf8"));
  } catch (e) {
    const msg = e?.message || String(e || "");
    if (/file does not exist/i.test(msg) || /no such file or directory/i.test(msg)) {
      return null;
    }
    console.warn("[MFS] readJson falló para", path, "-", msg);
    throw e;
  }
}

/**
 * Escribe un JSON en MFS (crea y trunca) en el writer flotante.
 */
async function mfsWriteJson(path, obj) {
  const { client } = await ensureIndexMfsSyncedForWriter();
  const data = Buffer.from(JSON.stringify(obj, null, 2), "utf8");
  const dir = path.replace(/\/[^/]+$/, "");
  if (dir) {
    try {
      await client.files.mkdir(dir, { parents: true });
    } catch (e) {
      const msg = e?.message || String(e || "");
      if (!/file exists/i.test(msg) && !/already exists/i.test(msg)) {
        console.warn("[MFS] mkdir falló para", dir, "-", msg);
      }
    }
  }
  await client.files.write(path, data, {
    create: true,
    truncate: true,
    parents: true,
  });
}

/**
 * Mueve un archivo dentro de MFS en el writer flotante.
 */
async function mfsMove(from, to) {
  const { client } = await ensureIndexMfsSyncedForWriter();
  const dir = to.replace(/\/[^/]+$/, "");
  if (dir) {
    try {
      await client.files.mkdir(dir, { parents: true });
    } catch (e) {
      const msg = e?.message || String(e || "");
      if (!/file exists/i.test(msg) && !/already exists/i.test(msg)) {
        console.warn("[MFS] mkdir falló para", dir, "-", msg);
      }
    }
  }
  await client.files.mv(from, to);
}

/* ------------------------------------------------------------------
 *  Root del índice: /cert-index (CID + IPNS)
 * ------------------------------------------------------------------ */

/**
 * Obtiene el CID actual del índice:
 *
 * 1) Si hay IPNS (IPFS_INDEX_IPNS_KEY), intenta resolver /ipns/<key>
 *    y devuelve el CID al que apunta.
 * 2) Si no hay IPNS o falla, hace fallback a /cert-index en el writer MFS.
 */
async function getRootCid() {
  // 1) PRIMERO: Intentar MFS local del WRITER ACTUAL si existe
  // Esto garantiza que leemos lo que acabamos de escribir (read-your-writes)
  if (currentWriter) {
    try {
      console.log(`[getRootCid] Intentando leer de writer activo: ${currentWriter.base}`);
      const st = await currentWriter.client.files.stat("/cert-index", { hash: true });
      const cid = (st.cid || st.hash || "").toString();
      if (cid) return cid;
    } catch (e) {
      console.warn("[getRootCid] Falló lectura en currentWriter:", e.message);
    }
  }

  // 2) Si no hay writer activo, intentar con el primer endpoint (lectura normal)
  try {
    const localClient = create(IPFS_ENDPOINTS[0]);
    const st = await localClient.files.stat("/cert-index", { hash: true });
    const cid = (st.cid || st.hash || "").toString();
    if (cid) {
      return cid;
    }
  } catch (e) {
    // Ignoramos error si no existe localmente y vamos a IPNS
  }

  // 3) TERCERO: IPNS (lectura global / fallback)
  if (IPFS_INDEX_IPNS_KEY) {
    try {
      // Usamos el cliente local para resolver IPNS
      const client = create(IPFS_ENDPOINTS[0]);
      const stream = client.name.resolve(`/ipns/${IPFS_INDEX_IPNS_KEY}`);
      for await (const name of stream) {
        const m = name.match(/\/ipfs\/([^/]+)/);
        if (m && m[1]) {
          return m[1];
        }
      }
    } catch (e) {
      console.warn("[IPNS] No se pudo resolver rootCid vía IPNS; fallback a MFS writer sync:", e?.message || String(e));
    }
  }

  // 4) Fallback final: Forzar sync del writer (si no se pudo leer arriba)
  const { client } = await ensureIndexMfsSyncedForWriter();
  const st = await client.files.stat("/cert-index", { hash: true });
  const cid = (st.cid || st.hash || "").toString();
  if (!cid) throw new Error("No se pudo obtener CID de /cert-index");
  return cid;
}

/**
 * Publica (o actualiza) el root actual del índice:
 *  - Obtiene CID de /cert-index en el writer
 *  - Lo pinea (pin.add) vía cluster proxy (replicación en N nodos)
 *  - Si hay IPNS_KEY => name.publish(/ipfs/<cid>) con esa key
 */
async function publishIndexRoot() {
  // Ensure we have a fresh client and obtain the /cert-index stat
  const { client } = await ensureIndexMfsSyncedForWriter();
  const st = await client.files.stat("/cert-index", { hash: true });
  // ... código existente ...

  const cid = (st.cid || st.hash || "").toString();
  if (!cid) throw new Error("No se pudo obtener CID de /cert-index");
  // Pin en cluster
  try {
    if (client.pin && client.pin.add) {
      await client.pin.add(cid);
      console.log("[IPFS] rootCid pineado en cluster:", cid);
    }
  } catch (e) {
    console.warn("[IPFS] pin.add falló:", e?.message);
  }
  // Publicar en IPNS
  if (IPFS_INDEX_IPNS_KEY) {
    try {
      await client.name.publish(`/ipfs/${cid}`, {
        key: IPFS_INDEX_IPNS_KEY,
      });
      console.log(`[IPNS] Publicado /ipns/${IPFS_INDEX_IPNS_KEY} -> /ipfs/${cid}`);

      // NUEVO: Delay post-publish para propagación
      console.log("[IPNS] Esperando 2s para propagación...");
      await new Promise(resolve => setTimeout(resolve, 2000));
      console.log("[IPNS] ✅ Propagación completa");
    } catch (e) {
      console.warn("[IPNS] publish falló:", e?.message);
    }
  }
  return cid;
}

/* ------------------------------------------------------------------
 *  Exports
 * ------------------------------------------------------------------ */

export {
  normalizeOwnerName,
  shardPrefix,
  keyPrefixFromOwner,
  ensureMfsDirs,
  mfsReadJsonOrNull,
  mfsWriteJson,
  mfsMove,
  getRootCid,
  publishIndexRoot,
};

export default ipfsFailover;
