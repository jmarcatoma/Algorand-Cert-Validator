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
const IPFS_ENDPOINTS = (
  process.env.IPFS_ENDPOINTS ||
  process.env.IPFS_API_URL ||
  "http://127.0.0.1:5001"
)
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

if (!IPFS_ENDPOINTS.length) {
  console.warn("[IPFS] No hay endpoints configurados, usando http://127.0.0.1:5001");
  IPFS_ENDPOINTS.push("http://127.0.0.1:5001");
}

// Key IPNS que usaremos para publicar el root del índice
// Debe existir en TODOS los nodos (ipfs key import algocert-index-key ...)
const IPFS_INDEX_IPNS_KEY =
  process.env.IPFS_INDEX_IPNS_KEY ||
  process.env.CERT_INDEX_IPNS_KEY || // alias por si acaso
  null;

/**
 * Crea un cliente IPFS para un endpoint dado.
 * Si estás usando ipfs-cluster proxy, normalmente será http://host:9095.
 * El proxy y go-ipfs exponen la API en /api/v0.
 */
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
  let lastErr;
  for (const base of IPFS_ENDPOINTS) {
    try {
      const client = createClient(base);
      for await (const chunk of client.cat(cid, opts)) {
        yield chunk;
      }
      return; // terminó bien
    } catch (e) {
      lastErr = e;
      console.error("[IPFS] cat falló en:", base, "-", e?.message || String(e));
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
  add: (data, opts) => withIpfs(c => c.add(data, opts)),
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

async function pickWriter() {
  let lastErr;
  for (const base of IPFS_ENDPOINTS) {
    try {
      const client = createClient(base);
      await client.id(); // prueba rápida de salud
      currentWriter = { client, base };
      console.log("[IPFS-Writer] ✅ usando", base, "como writer MFS");
      return currentWriter;
    } catch (e) {
      lastErr = e;
      console.warn("[IPFS-Writer] endpoint no disponible como writer:", base, "-", e?.message || String(e));
    }
  }
  throw lastErr || new Error("No hay writer IPFS disponible");
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
 * Sincroniza /cert-index en el writer actual con el rootCid publicado por IPNS
 * (si existe). Si no hay IPNS configurado o no hay publicación previa,
 * simplemente se asegura de que /cert-index exista.
 */
async function ensureIndexMfsSyncedForWriter() {
  const { client, base } = await getWriter();

  // Caso 1: sin IPNS configurado, nos limitamos a tener /cert-index creado
  if (!IPFS_INDEX_IPNS_KEY) {
    try {
      await client.files.stat("/cert-index");
    } catch (e) {
      const msg = e?.message || String(e || "");
      if (/does not exist|no such file/i.test(msg)) {
        await client.files.mkdir("/cert-index", { parents: true });
        console.log("[MFS] /cert-index creado en", base, "(sin IPNS)");
      } else {
        console.warn("[MFS] stat /cert-index falló en", base, "-", msg);
      }
    }
    return { client, base, rootCid: null, syncedFromIpns: false };
  }

  // Caso 2: con IPNS => IPNS es la verdad global
  let ipnsCid = null;
  try {
    const res = await client.name.resolve(`/ipns/${IPFS_INDEX_IPNS_KEY}`);
    const path = res.Path || res.path || "";
    const m = path.match(/\/ipfs\/([^/]+)/);
    if (m) ipnsCid = m[1];
  } catch (e) {
    console.warn("[IPNS] No se pudo resolver /ipns/" + IPFS_INDEX_IPNS_KEY + " en", base, "-", e?.message || String(e));
  }

  // Si no hay publicación previa en IPNS, sólo aseguramos /cert-index
  if (!ipnsCid) {
    try {
      await client.files.stat("/cert-index");
    } catch (e) {
      const msg = e?.message || String(e || "");
      if (/does not exist|no such file/i.test(msg)) {
        await client.files.mkdir("/cert-index", { parents: true });
        console.log("[MFS] /cert-index creado en", base, "(IPNS aún sin root)");
      } else {
        console.warn("[MFS] stat /cert-index falló en", base, "-", msg);
      }
    }
    return { client, base, rootCid: null, syncedFromIpns: false };
  }

  // Si ya sincronizamos este CID en este proceso, no hacemos nada
  if (lastSyncedCid === ipnsCid) {
    return { client, base, rootCid: ipnsCid, syncedFromIpns: true };
  }

  // Comparamos el CID local de /cert-index con el de IPNS
  let localCid = null;
  try {
    const st = await client.files.stat("/cert-index", { hash: true });
    localCid = (st.cid || st.hash || "").toString();
  } catch (e) {
    // no existe /cert-index -> forzamos clon
  }

  if (localCid !== ipnsCid) {
    console.warn(`[MFS] /cert-index en ${base} desfasado (${localCid} != ${ipnsCid}), re-sincronizando...`);
    try {
      await client.files.rm("/cert-index", { recursive: true });
    } catch {
      // ok si no existía
    }
    await client.files.cp(`/ipfs/${ipnsCid}`, "/cert-index");
    console.log(`[MFS] /cert-index sincronizado desde /ipfs/${ipnsCid} en ${base}`);
  }

  lastSyncedCid = ipnsCid;
  return { client, base, rootCid: ipnsCid, syncedFromIpns: true };
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
  // 1) Intento vía IPNS (lectura global, no depende del writer)
  if (IPFS_INDEX_IPNS_KEY) {
    try {
      const res = await withIpfs(c => c.name.resolve(`/ipns/${IPFS_INDEX_IPNS_KEY}`));
      const path = res.Path || res.path || "";
      const m = path.match(/\/ipfs\/([^/]+)/);
      if (m && m[1]) {
        return m[1];
      }
    } catch (e) {
      console.warn("[IPNS] No se pudo resolver rootCid vía IPNS; fallback a MFS:", e?.message || String(e));
    }
  }

  // 2) Fallback: CID local de /cert-index en el writer
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
  const { client, base } = await ensureIndexMfsSyncedForWriter();

  const st = await client.files.stat("/cert-index", { hash: true });
  const cid = (st.cid || st.hash || "").toString();
  if (!cid) throw new Error("No se pudo obtener CID de /cert-index");

  // 1) Pin global (si estamos hablando con ipfs-cluster proxy, esto dispara el pin en el cluster)
  try {
    if (client.pin && client.pin.add) {
      await client.pin.add(cid);
      console.log("[IPFS] rootCid pineado en cluster:", cid, "vía", base);
    } else {
      console.warn("[IPFS] client.pin.add no disponible; omitiendo pin explícito (puede que cluster ya maneje esto).");
    }
  } catch (e) {
    console.warn("[IPFS] pin.add(rootCid) falló (se continúa igualmente):", e?.message || String(e));
  }

  // 2) Publicar en IPNS (si está configurado)
  if (IPFS_INDEX_IPNS_KEY) {
    try {
      await client.name.publish(`/ipfs/${cid}`, {
        key: IPFS_INDEX_IPNS_KEY,
        // lifetime: '8760h',     // opcional (1 año)
        // allowOffline: true,    // opcional si el nodo es offline friendly
      });
      console.log(`[IPNS] Publicado /ipns/${IPFS_INDEX_IPNS_KEY} -> /ipfs/${cid}`);
      lastSyncedCid = cid; // lo que acabamos de publicar es el nuevo root
    } catch (e) {
      console.warn("[IPNS] publish falló:", e?.message || String(e));
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
