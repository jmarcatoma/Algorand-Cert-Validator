// backend/indexing.mjs
import { create as createIpfsClient } from 'ipfs-http-client';
import crypto from 'crypto';

const {
  IPFS_API_URL,
  CERT_INDEX_MFS_ROOT = '/cert-index',
  CERT_INDEX_SHARDS = '2',
  CERT_INDEX_IPNS_KEY,
  CERT_INDEX_CACHE_TTL_SEC = '120',
  CERT_INDEX_ROOT_CID, // opcional: usar root cid fijo si no hay IPNS
} = process.env;

const ipfs = createIpfsClient({ url: IPFS_API_URL });

// cache simple en memoria
let _cachedRoot = { cid: null, ts: 0 };

export function normalizeOwnerName(name) {
  if (!name) return '';
  // MAYÚSCULAS, sin tildes, quitar dobles espacios
  const noTildes = name.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  return noTildes.replace(/\s+/g, ' ').trim().toUpperCase();
}

export function shardPrefix(hexLike, shards = Number(CERT_INDEX_SHARDS)) {
  const clean = String(hexLike || '').replace(/[^0-9a-f]/gi, '').toLowerCase();
  if (clean.length < shards) return clean.padEnd(shards, '0');
  return clean.slice(0, shards);
}

export function keyPrefixFromOwner(ownerNorm, shards = Number(CERT_INDEX_SHARDS)) {
  // Para índices por dueño usamos prefijo por las primeras 2 letras
  const clean = String(ownerNorm || '').replace(/[^A-Z0-9_ ]/g, '').toUpperCase();
  const lettersOnly = clean.replace(/[^A-Z]/g, '');
  if (!lettersOnly) return 'ZZ';
  return lettersOnly.slice(0, shards || 2).padEnd(shards || 2, 'Z');
}

export async function ensureMfsDirs(paths = []) {
  for (const dir of paths) {
    try {
      await ipfs.files.mkdir(dir, { parents: true });
    } catch (e) {
      // exists ok
    }
  }
}

export async function mfsWriteJson(path, obj) {
  const data = Buffer.from(JSON.stringify(obj, null, 2));
  await ipfs.files.write(path, data, { create: true, truncate: true, parents: true });
}

export async function mfsReadJsonOrNull(path) {
  try {
    const chunks = [];
    for await (const c of ipfs.files.read(path)) chunks.push(c);
    const buf = Buffer.concat(chunks);
    return JSON.parse(buf.toString('utf8'));
  } catch (e) {
    return null;
  }
}

export async function mfsMove(src, dst) {
  // mover de staging a definitivo (commit “atómico” a nivel lógico)
  await ensureMfsDirs([dst.split('/').slice(0, -1).join('/') || '/']);
  await ipfs.files.mv(src, dst);
}

export async function getRootCid() {
  const ttl = Number(CERT_INDEX_CACHE_TTL_SEC) * 1000;
  const now = Date.now();

  // 1) Si hay CID fijo en env, úsalo
  if (CERT_INDEX_ROOT_CID) return CERT_INDEX_ROOT_CID;

  // 2) Cache IPNS
  if (_cachedRoot.cid && now - _cachedRoot.ts < ttl) {
    return _cachedRoot.cid;
  }

  // 3) Si no hay key IPNS, obtenemos el CID actual del MFS root
  if (!CERT_INDEX_IPNS_KEY) {
    const stat = await ipfs.files.stat(CERT_INDEX_MFS_ROOT);
    _cachedRoot = { cid: stat.cid.toString(), ts: now };
    return _cachedRoot.cid;
  }

  // 4) Resolver IPNS (key ya publicada previamente)
  // Obtenemos el CID del directorio raíz por MFS y lo publicamos justo antes de resolver
  const stat = await ipfs.files.stat(CERT_INDEX_MFS_ROOT);
  const cid = stat.cid.toString();

  // publish
  try {
    await ipfs.name.publish(`/ipfs/${cid}`, { key: CERT_INDEX_IPNS_KEY });
  } catch (e) {
    // si falla publish, seguimos con el CID directo
  }

  _cachedRoot = { cid, ts: now };
  return cid;
}

// Publicar (opcional), y devolver root CID final
export async function publishIndexRoot() {
  const stat = await ipfs.files.stat(CERT_INDEX_MFS_ROOT);
  const cid = stat.cid.toString();
  if (CERT_INDEX_IPNS_KEY) {
    await ipfs.name.publish(`/ipfs/${cid}`, { key: CERT_INDEX_IPNS_KEY });
  }
  _cachedRoot = { cid, ts: Date.now() };
  return cid;
}

// Firma opcional de metadatos (si te interesa)
export function signMetaDetached(privateKeyPem, payloadObj) {
  const p = Buffer.from(JSON.stringify(payloadObj));
  const sign = crypto.createSign('RSA-SHA256'); // o ed25519 si usas libs específicas
  sign.update(p);
  sign.end();
  return sign.sign(privateKeyPem).toString('base64');
}

export default ipfs;
