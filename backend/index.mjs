// index.mjs
import express from 'express';
import cors from 'cors';
import multer from 'multer';
import crypto from 'crypto';
import dotenv from 'dotenv';
import { create } from 'ipfs-http-client';
import fs from 'fs';
import pool from './db.mjs';
import algosdk from 'algosdk';

dotenv.config();

// -------------------- NOTE parser (v1 y v2) --------------------
function parseAlgocertNote(noteUtf8, fallbackWallet = null) {
  if (!noteUtf8 || !noteUtf8.startsWith('ALGOCERT|')) return null;
  const p = noteUtf8.split('|');
  const version = p[1];
  const out = {
    version,
    hash: (p[2] || '').toLowerCase(),
    // v1
    cid: null,
    // v2
    tipo: null,
    nombre: null,
    // comunes
    wallet: fallbackWallet || null,
    // única fecha de proceso (ms)
    ts: null,
  };

  if (version === 'v1') { // ALGOCERT|v1|hash|cid|wallet|ts
    out.cid    = p[3] || null;
    out.wallet = p[4] || fallbackWallet || null;
    out.ts     = p[5] ? Number(p[5]) : null;
  } else if (version === 'v2') { // ALGOCERT|v2|hash|cid|tipo|nombre|wallet|ts
    out.cid    = p[3] || null;
    out.tipo   = p[4] || null;
    out.nombre = p[5] || null;
    out.wallet = p[6] || fallbackWallet || null;
    out.ts     = p[7] ? Number(p[6]) : null;
  }
  return out;
}

// --- Formateo Ecuador (seguro) ---
function toEcuadorLocal(ms) {
  if (ms == null || !Number.isFinite(ms)) return null;
  try {
    return new Intl.DateTimeFormat('es-EC', {
      timeZone: 'America/Guayaquil',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hour12: false
    }).format(new Date(ms));
  } catch {
    return new Date(ms).toISOString();
  }
}
const toEcStrOrNull = (ms) => (Number.isFinite(ms) ? toEcuadorLocal(ms) : null);



// ------------------ Address helper (intacto) -------------------
const toAddrString = (addrLike) => {
  if (!addrLike) return null;
  if (typeof addrLike === 'string') {
    const cleaned = addrLike.trim();
    return algosdk.isValidAddress(cleaned) ? cleaned : null;
  }
  if (addrLike.addr && typeof addrLike.addr === 'string') {
    const cleaned = addrLike.addr.trim();
    return algosdk.isValidAddress(cleaned) ? cleaned : null;
  }
  if (addrLike.publicKey) {
    try {
      const publicKeyBytes = addrLike.publicKey instanceof Uint8Array
        ? addrLike.publicKey
        : new Uint8Array(Object.values(addrLike.publicKey));
      if (publicKeyBytes.length === 32) {
        const addr = algosdk.encodeAddress(publicKeyBytes);
        return algosdk.isValidAddress(addr) ? addr : null;
      }
    } catch (e) {
      console.error('[toAddrString] Error procesando publicKey:', e.message);
      return null;
    }
  }
  if (addrLike instanceof Uint8Array && addrLike.length === 32) {
    try {
      const addr = algosdk.encodeAddress(addrLike);
      return algosdk.isValidAddress(addr) ? addr : null;
    } catch (e) {
      console.error('[toAddrString] Error con Uint8Array:', e.message);
      return null;
    }
  }
  return null;
};

// --- Helpers Indexer fallback (REST) ---
const IDX_CHAIN = (process.env.INDEXER_URLS || (process.env.INDEXER_URL || 'https://mainnet-idx.algonode.cloud'))
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

function buildIdxUrl(base, { b64prefix, wallet, role, limit, afterIso, beforeIso }) {
  const qs = new URLSearchParams();
  qs.set('note-prefix', b64prefix);
  qs.set('tx-type', 'pay');
  qs.set('limit', String(limit ?? 1));
  if (wallet) {
    qs.set('address', wallet);
    if (role) qs.set('address-role', role); // 'receiver' o 'sender'
  }
  if (afterIso) qs.set('after-time', afterIso);
  if (beforeIso) qs.set('before-time', beforeIso);
  return `${base}/v2/transactions?${qs.toString()}`;
}

async function fetchIdx(base, url) {
  const r = await fetch(url, { headers: { accept: 'application/json' } });
  if (!r.ok) throw new Error(`[${base}] ${r.status} ${await r.text()}`);
  return r.json();
}

// Normaliza la respuesta del indexer
function normalizeTxResp(j) {
  const tx = (j && j.transactions && j.transactions[0]) || null;
  if (!tx) return null;
  const noteUtf8 = tx.note ? Buffer.from(tx.note, 'base64').toString('utf8') : null;
  return {
    txId: tx.id,
    round: tx['confirmed-round'] || null,
    from: tx.sender,
    to: tx['payment-transaction']?.receiver || null,
    noteUtf8,
  };
}

// --- Fin helpers Indexer fallback ---

const app = express();
const PORT = process.env.PORT || 4000;
const toJSONSafe = (x) =>
  JSON.parse(JSON.stringify(x, (_, v) => (typeof v === 'bigint' ? v.toString() : v)));

// ---------- ALGOD client ----------
const ALGOD_URL   = process.env.ALGOD_URL || 'http://127.0.0.1:4001';
const ALGOD_TOKEN = process.env.ALGOD_TOKEN || '';

const u = new URL(ALGOD_URL);
const ALGOD_HOST = `${u.protocol}//${u.hostname}`;
const ALGOD_PORT = u.port
  ? Number(u.port)
  : (u.protocol === 'https:' ? 443 : 4001);

// Ventana temporal por horas (parametrizable)
const IDX_LOOKBACK_HOURS = Math.max(1, Number(process.env.IDX_LOOKBACK_HOURS || '1'));
const IDX_AHEAD_HOURS    = Math.max(0, Number(process.env.IDX_AHEAD_HOURS    || '1'));

const algodClient = new algosdk.Algodv2(ALGOD_TOKEN, ALGOD_URL, ALGOD_PORT);
const MNEMONIC = process.env.ALGOD_MNEMONIC;

let serverAcct = null;
if (MNEMONIC) {
  try {
    const m = (process.env.ALGOD_MNEMONIC || '').trim();
    const words = m.split(/\s+/).filter(Boolean);
    console.log(`[DEBUG] Mnemonic words count: ${words.length}`);
    if (words.length !== 25) {
      console.warn(`[Signer] ALGOD_MNEMONIC inválido: ${words.length} palabras (deben ser 25)`);
    } else {
      const account = algosdk.mnemonicToSecretKey(words.join(' '));
      console.log('[DEBUG] Account from mnemonic:', {
        hasAddr: !!account.addr,
        addrType: typeof account.addr,
        addr: account.addr,
        hasSecretKey: !!account.sk
      });
      if (typeof account.addr === 'string' && algosdk.isValidAddress(account.addr)) {
        serverAcct = account;
        console.log(`[Signer] ✅ Cuenta cargada correctamente: ${serverAcct.addr}`);
      } else {
        console.warn('[Signer] addr no es string válido, intentando generar desde publicKey...');
        if (account.sk && account.sk.length >= 32) {
          const publicKey = account.sk.slice(32, 64);
          const addr = algosdk.encodeAddress(publicKey);
          serverAcct = { addr, sk: account.sk };
          console.log(`[Signer] ✅ Dirección regenerada: ${serverAcct.addr}`);
        } else {
          console.error('[Signer] No se pudo generar dirección válida');
        }
      }
    }
  } catch (e) {
    console.error('[Signer] Error cargando mnemónico:', e.message || e);
    serverAcct = null;
  }
} else {
  console.warn('[ANCHOR] Falta ALGOD_MNEMONIC en .env; /api/algod/anchorNote deshabilitado');
}

console.log('[Signer] Estado final:', {
  configured: !!serverAcct,
  hasValidAddr: serverAcct ? algosdk.isValidAddress(serverAcct.addr) : false,
  address: serverAcct?.addr || 'N/A'
});

// Esperar confirmación simple (opcional)
async function waitForConfirmation(algod, txId, timeout = 15) {
  const start = Date.now();
  let lastRound = (await algod.status().do())['last-round'];
  while ((Date.now() - start) / 1000 < timeout) {
    const p = await algod.pendingTransactionInformation(txId).do();
    if (p['confirmed-round'] && p['confirmed-round'] > 0) return p;
    lastRound += 1;
    await algod.statusAfterBlock(lastRound).do();
  }
  return null; // si no confirmó en el timeout
}

console.log('[ALGOD_URL]', ALGOD_URL);
console.log('[ALGOD_HOST]', ALGOD_HOST);
console.log('[ALGOD_PORT]', ALGOD_PORT);
console.log('[ALGOD_TOKEN length]', (ALGOD_TOKEN || '').length);

// ---------- INDEXER client (público) ----------
const INDEXER_URL = process.env.INDEXER_URL || 'https://mainnet-idx.algonode.cloud';
const indexerClient = new algosdk.Indexer('', INDEXER_URL, '');
console.log('[INDEXER_URL]', INDEXER_URL);

// ---------- Middlewares ----------
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// ---------- Rutas básicas ----------
app.get('/', (req, res) => {
  res.json({
    ok: true,
    service: 'certificates-api',
    env: process.env.NODE_ENV || 'dev',
    port: Number(PORT),
    time: new Date().toISOString(),
  });
});

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    uptime_s: Math.round(process.uptime()),
    time: new Date().toISOString(),
  });
});

// ---------- DB: certificados ----------
app.get('/certificados', async (_req, res) => {
  try {
    const result = await pool.query('SELECT * FROM certificados ORDER BY fecha DESC');
    res.json(result.rows);
  } catch (err) {
    console.error('❌ Error al obtener certificados:', err);
    res.status(500).json({ error: 'Error al obtener certificados' });
  }
});

app.delete('/eliminar-certificado/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const result = await pool.query('DELETE FROM certificados WHERE id = $1', [id]);
    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Certificado no encontrado' });
    }
    res.json({ message: 'Certificado eliminado correctamente' });
  } catch (err) {
    console.error('❌ Error al eliminar certificado:', err);
    res.status(500).json({ error: 'Error al eliminar el certificado' });
  }
});

// ---------- DB: roles ----------
app.post('/guardar-rol', async (req, res) => {
  const { wallet, role } = req.body;
  if (!wallet || !role) {
    return res.status(400).json({ error: 'Faltan datos' });
  }
  try {
    await pool.query(
      'INSERT INTO wallet_roles (wallet, role) VALUES ($1, $2) ON CONFLICT (wallet) DO UPDATE SET role = EXCLUDED.role',
      [wallet, role]
    );
    res.json({ message: 'Rol guardado correctamente' });
  } catch (err) {
    console.error('❌ Error al guardar rol:', err);
    res.status(500).json({ error: 'Error al guardar el rol' });
  }
});

app.delete('/eliminar-rol/:wallet', async (req, res) => {
  const { wallet } = req.params;
  try {
    const result = await pool.query('DELETE FROM wallet_roles WHERE wallet = $1', [wallet]);
    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Wallet no encontrada' });
    }
    res.json({ message: 'Rol eliminado correctamente' });
  } catch (err) {
    console.error('❌ Error en /eliminar-rol:', err);
    res.status(500).json({ error: 'Error al eliminar el rol' });
  }
});

app.get('/roles/:wallet', async (req, res) => {
  const { wallet } = req.params;
  try {
    const result = await pool.query('SELECT role FROM wallet_roles WHERE wallet = $1', [wallet]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'No se encontró un rol para esta wallet' });
    }
    res.json({ role: result.rows[0].role });
  } catch (err) {
    console.error('❌ Error en /roles/:wallet:', err);
    res.status(500).json({ error: 'Error interno' });
  }
});

app.get('/api/indexer/health', async (_req, res) => {
  try {
    const h = await indexerClient.makeHealthCheck().do();
    res.json({ ok: true, ...h });
  } catch (e) {
    res.status(503).json({ ok: false, error: e?.message || String(e) });
  }
});

// ---------- IPFS ----------
const ipfs = create({ url: 'http://192.168.101.194:9095/api/v0' });

// ---------- Multer ----------
const upload = multer({ dest: 'uploads/' });

// ---------- Subir certificado + hash automático ----------
app.post('/subir-certificado', upload.single('file'), async (req, res) => {
  const file = req.file;
  const wallet = req.body.wallet;
  if (!file || !wallet) {
    return res.status(400).json({ error: 'Archivo PDF y wallet requeridos' });
  }

  const buffer = fs.readFileSync(file.path);
  const hash = crypto.createHash('sha256').update(buffer).digest('hex');

  try {
    // ¿ya existe?
    const result = await pool.query('SELECT 1 FROM certificados WHERE hash = $1', [hash]);
    if (result.rows.length > 0) {
      fs.unlinkSync(file.path);
      return res.status(409).json({ error: 'Ya existe un certificado con este hash' });
    }

    // Subir a IPFS
    const added = await ipfs.add(buffer);
    const cid = added.cid.toString();

    // Guardar en BD (sin txid/round aquí; esta ruta es solo IPFS+hash)
    await pool.query(
      'INSERT INTO certificados (wallet, nombre_archivo, hash, cid) VALUES ($1, $2, $3, $4)',
      [wallet, file.originalname, hash, cid]
    );

    fs.unlinkSync(file.path);
    res.json({ message: 'Certificado subido', cid, hash });
  } catch (err) {
    console.error('❌ Error en /subir-certificado:', err);
    res.status(500).json({ error: 'Error al subir el certificado' });
  }
});

// ---------- Guardar título (usa hash del front) + IPFS + opcional txid/round ----------
app.post('/guardar-titulo', upload.single('file'), async (req, res) => {
  try {
    const { wallet } = req.body;
    const file = req.file;
    if (!file || !wallet) return res.status(400).json({ error: 'Faltan datos (file, wallet)' });

    const buffer = fs.readFileSync(file.path);

    // ✅ Hash CANÓNICO calculado en servidor
    const serverHashHex = crypto.createHash('sha256').update(buffer).digest('hex');

    // ¿ya existe?
    const dup = await pool.query('SELECT 1 FROM certificados WHERE hash = $1', [serverHashHex]);
    if (dup.rowCount > 0) {
      fs.unlinkSync(file.path);
      return res.status(409).json({ error: 'Hash ya registrado', hash: serverHashHex });
    }

    // Subir a IPFS
    const added = await ipfs.add(buffer);
    const cid = added.cid.toString();

    // Guardar en BD
    await pool.query(
      'INSERT INTO certificados (wallet, nombre_archivo, hash, cid) VALUES ($1, $2, $3, $4)',
      [wallet, file.originalname, serverHashHex, cid]
    );

    fs.unlinkSync(file.path);

    // 🔁 DEVOLVEMOS hash canónico
    return res.json({ message: 'Título guardado', cid, hash: serverHashHex });
  } catch (err) {
    console.error('Error al guardar título:', err);
    return res.status(500).json({ error: 'Error interno al guardar título' });
  }
});

// ---------- ALGOD: salud ----------
app.get('/api/algod/health', async (req, res) => {
  try {
    await algodClient.healthCheck().do();
    res.json({ ok: true });
  } catch (e) {
    console.error('ALGOD /health error:', e);
    res.status(503).json({ ok: false, error: e?.message || String(e), cause: e?.cause?.code || null });
  }
});

// ---------- ALGOD: status ----------
app.get('/api/algod/status', async (_req, res) => {
  try {
    const st = await algodClient.status().do();
    res.json({
      lastRound: st['lastRound'],
      timeSinceLastRound: st['timeSinceLastRound'],
      catchupTime: st['catchupTime'] ?? null,
      lastCatchpoint: st['catchpoint'] ?? null,
    });
  } catch (e) {
    res.status(500).json({ error: e?.message || String(e) });
  }
});

// ---------- ALGOD: suggested params ----------
app.get('/api/algod/params', async (_req, res) => {
  try {
    const p = await algodClient.getTransactionParams().do();
    const safe = JSON.parse(JSON.stringify(p, (k, v) => (typeof v === 'bigint' ? Number(v) : v)));
    res.json(safe);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- ALGOD: enviar TX firmada (raw base64) ----------
app.post('/api/algod/sendRaw', async (req, res) => {
  try {
    const { raw } = req.body; // raw base64
    if (!raw) return res.status(400).json({ error: 'Falta campo raw (base64)' });
    const bytes = Buffer.from(raw, 'base64');
    const result = await algodClient.sendRawTransaction(bytes).do();
    res.json(result); // { txId: '...' }
  } catch (e) {
    res.status(500).json({ error: e?.message || String(e), text: e?.response?.text });
  }
});

// ---------- INDEXER: placeholder ----------
app.get('/api/indexer/verify', (_req, res) => {
  return res.status(501).json({ error: 'Indexer no configurado en el backend' });
});

// ---------- Adjuntar txId/round a un certificado por hash ----------
app.post('/api/certificados/:hash/attach-tx', express.json(), async (req, res) => {
  try {
    const { hash } = req.params;
    const { txId, round } = req.body || {};
    if (!hash || !txId) return res.status(400).json({ error: 'Faltan hash o txId' });

    const q = `
      UPDATE certificados
         SET txid = $1, round = COALESCE($2, round)
       WHERE hash = $3
       RETURNING id, wallet, nombre_archivo, hash, cid, txid, round, fecha;
    `;
    const r = await pool.query(q, [txId, round ?? null, hash]);
    if (r.rowCount === 0) return res.status(404).json({ error: 'Hash no encontrado' });

    res.json({ ok: true, row: r.rows[0] });
  } catch (e) {
    console.error('attach-tx error:', e);
    res.status(500).json({ error: e?.message || String(e) });
  }
});

// ---------- Estado simple de una tx usando algod ----------
app.get('/api/tx/:txId/status', async (req, res) => {
  try {
    const { txId } = req.params;
    const info = await algodClient.pendingTransactionInformation(txId).do();
    res.json({
      txId,
      confirmedRound: info['confirmed-round'] ?? null,
      poolError: info['pool-error'] || null
    });
  } catch (e) {
    res.status(500).json({ error: e?.message || String(e) });
  }
});

// ---------- Anclar usando note v1 ----------
// NOTE: ALGOCERT|v1|<hash>|<cid>|<wallet>|<ts>
app.post('/api/algod/anchorNote', express.json(), async (req, res) => {
  try {
    if (!serverAcct) return res.status(501).json({ error: 'Server signer no configurado' });

    let { to, hashHex, cid, filename } = req.body || {};
    to = String(to || '').trim();
    hashHex = String(hashHex || '').trim().toLowerCase();
    cid = String(cid || '').trim();
    filename = (String(filename || '').trim()).slice(0, 128);

    if (!algosdk.isValidAddress(to)) return res.status(400).json({ error: `to inválido: ${to}` });
    if (!/^[0-9a-f]{64}$/.test(hashHex)) return res.status(400).json({ error: 'hashHex inválido (64 hex chars)' });
    if (!cid) return res.status(400).json({ error: 'cid requerido' });

    // ✅ fecha 100% backend
    const ts = Date.now();

    // ⚠️ Usa ts, NO processTs
    const noteStr = `ALGOCERT|v1|${hashHex}|${cid}|${to}|${ts}`;
    const note = new Uint8Array(Buffer.from(noteStr, 'utf8'));

    const raw = await algodClient.getTransactionParams().do();
    const sp = { ...raw, flatFee: true, fee: Number(raw.minFee || raw.fee || 1000) };

    const txn = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
      from: serverAcct.addr, to, amount: 0, note, suggestedParams: sp,
    });

    const signed = txn.signTxn(serverAcct.sk);
    const { txId } = await algodClient.sendRawTransaction(signed).do();
    const confirmed = await waitForConfirmation(algodClient, txId, 12).catch(() => null);
    const round = confirmed ? confirmed['confirmed-round'] : null;

    return res.json({
      ok: true,
      txId,
      round,
      notePreview: noteStr.slice(0, 200),
      processTs: ts,                        // <- clave del JSON, valor ts
      processAtLocal: toEcuadorLocal(ts),   // <- formateado Ecuador
    });
  } catch (e) {
    console.error('anchorNote error:', e);
    return res.status(500).json({ error: e?.message || String(e) });
  }
});


// ---------- Anclar usando note v2 ----------
// NOTE: ALGOCERT|v2|<hash>|<tipo>|<nombre>|<wallet>|<ts>
app.post('/api/algod/anchorNoteUpload', express.json(), async (req, res) => {
  try {
    if (!serverAcct) return res.status(501).json({ error: 'Server signer no configurado' });

    let { to, hashHex, cid, tipo, nombreCert, filename } = req.body || {};
    
    to         = String(to || '').trim();
    hashHex    = String(hashHex || '').trim().toLowerCase();
    cid        = String(cid || '').trim();
    tipo       = String(tipo || '').trim();
    nombreCert = String(nombreCert || '').trim();
    filename   = (String(filename || '').trim()).slice(0, 128);

    if (!algosdk.isValidAddress(to)) return res.status(400).json({ error: `to inválido: ${to}` });
    if (!/^[0-9a-f]{64}$/.test(hashHex)) return res.status(400).json({ error: 'hashHex inválido (64 hex chars)' });
    if (!tipo) return res.status(400).json({ error: 'tipo requerido' });
    if (!nombreCert) return res.status(400).json({ error: 'nombreCert requerido' });
    if (!cid) return res.status(400).json({ error: 'cid requerido' });

    const clean = (s, max = 160) => s.replace(/\|/g, ' ').slice(0, max);

    // ✅ fecha 100% backend
    const ts = Date.now();

    // ⚠️ Usa ts, NO processTs
    const noteStr = `ALGOCERT|v2|${hashHex}|${cid}|${clean(tipo,64)}|${clean(nombreCert,160)}|${to}|${ts}`;
    const note = new Uint8Array(Buffer.from(noteStr, 'utf8'));

    const raw = await algodClient.getTransactionParams().do();
    const sp = { ...raw, flatFee: true, fee: Number(raw.minFee || raw.fee || 1000) };

    const txn = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
      from: serverAcct.addr, to, amount: 0, note, suggestedParams: sp,
    });

    const signed = txn.signTxn(serverAcct.sk);
    const { txId } = await algodClient.sendRawTransaction(signed).do();
    const confirmed = await waitForConfirmation(algodClient, txId, 12).catch(() => null);
    const round = confirmed ? confirmed['confirmed-round'] : null;

    return res.json({
      ok: true,
      txId,
      round,
      notePreview: noteStr.slice(0, 200),
      processTs: ts,
      processAtLocal: toEcuadorLocal(ts),
    });
  } catch (e) {
    console.error('anchorNoteUpload error:', e);
    return res.status(500).json({ error: e?.message || String(e) });
  }
});


// ---------- BD: adjuntar txid/round (cuerpo con hash) ----------
app.post('/api/certificados/attach-tx', express.json(), async (req, res) => {
  const { hash, txid, round } = req.body || {};
  if (!hash || !txid) return res.status(400).json({ error: 'Faltan hash o txid' });
  try {
    const q = `
      UPDATE certificados
      SET txid = $1, round = $2
      WHERE hash = $3
      RETURNING id, wallet, nombre_archivo, cid, hash, txid, round, fecha
    `;
    const result = await pool.query(q, [txid, round || null, hash]);
    if (result.rowCount === 0) return res.status(404).json({ error: 'hash no encontrado' });
    res.json(result.rows[0]);
  } catch (e) {
    console.error('attach-tx error', e);
    res.status(500).json({ error: e?.message || String(e) });
  }
});

app.get('/api/algod/signer', (req, res) => {
  const addr = toAddrString(serverAcct?.addr);
  res.json({
    configured: !!serverAcct && !!addr,
    address: addr,
  });
});

// Endpoint temporal para debug
app.get('/api/debug/signer', (req, res) => {
  res.json({
    hasServerAcct: !!serverAcct,
    hasSecretKey: !!serverAcct?.sk,
    address: serverAcct?.addr || null,
    addressIsValid: serverAcct?.addr ? algosdk.isValidAddress(serverAcct.addr) : false,
    mnemonicConfigured: !!process.env.ALGOD_MNEMONIC,
    mnemonicLength: process.env.ALGOD_MNEMONIC ? process.env.ALGOD_MNEMONIC.trim().split(/\s+/).length : 0
  });
});

// ----- DESCARGAS
const hexToBase64 = (hex) => Buffer.from(hex, 'hex').toString('base64');

// --- Descargar el PDF EXACTO desde IPFS por hash ---
app.get('/api/certificados/:hash/download', async (req, res) => {
  try {
    const { hash } = req.params;
    const r = await pool.query(
      `SELECT nombre_archivo, cid
         FROM certificados
        WHERE hash = $1
        LIMIT 1`,
      [hash]
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'No existe ese hash' });

    const { nombre_archivo, cid } = r.rows[0];

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${(nombre_archivo || `documento-${hash.slice(0,8)}`).replace(/"/g,'')}.pdf"`
    );

    for await (const chunk of ipfs.cat(cid)) {
      res.write(chunk);
    }
    res.end();
  } catch (e) {
    console.error('download error:', e);
    res.status(502).json({ error: 'No se pudo descargar desde IPFS' });
  }
});

// --- HEAD lógico / redirect IPFS ---
app.get('/api/certificadosRedirect/:hash/download', async (req, res) => {
  try {
    const { hash } = req.params;
    const head = String(req.query.head || '').trim() === '1';

    const r = await pool.query(
      `SELECT cid, nombre_archivo FROM certificados WHERE hash = $1 LIMIT 1`,
      [hash]
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'No existe el hash' });

    const { cid } = r.rows[0];
    if (!cid) return res.status(404).json({ error: 'El certificado no tiene CID' });

    if (head) {
      return res.json({ ok: true, cid });
    }

    return res.redirect(`http://192.168.101.194:9095/ipfs/${cid}`);
  } catch (e) {
    console.error('download error:', e);
    res.status(500).json({ error: e?.message || String(e) });
  }
});

// --- Buscar certificado por hash (BD) ---
app.get('/api/certificados/by-hash/:hash', async (req, res) => {
  try {
    const { hash } = req.params;
    const r = await pool.query(
      `SELECT id, wallet, nombre_archivo, hash, cid, txid, round, fecha
         FROM certificados
        WHERE hash = $1
        LIMIT 1`,
      [hash]
    );
    if (r.rowCount === 0) {
      return res.status(404).json({ error: 'No existe un certificado con ese hash' });
    }
    res.json(r.rows[0]);
  } catch (e) {
    console.error('by-hash error:', e);
    res.status(500).json({ error: e?.message || String(e) });
  }
});

// --- Obtener info de una transacción por txId (Algod pending “raw”) ---
app.get('/api/algod/tx/:txId', async (req, res) => {
  try {
    const { txId } = req.params;
    const info = await algodClient.pendingTransactionInformation(txId).do();
    const safe = JSON.parse(JSON.stringify(info, (_, v) => (typeof v === 'bigint' ? Number(v) : v)));
    res.json(safe);
  } catch (e) {
    console.error('tx-info error:', e);
    res.status(500).json({ error: e?.message || String(e) });
  }
});

// ---------- Lookup transacción por txId (Indexer + parse NOTE) ----------
app.get('/api/indexer/tx/:txId', async (req, res) => {
  const { txId } = req.params;
  try {
    // 1) Indexer SDK
    try {
      const r = await indexerClient.lookupTransactionByID(txId).do();
      const tx = r?.transaction || null;
      if (tx) {
        const noteB64 = tx.note || null;
        const noteUtf8 = noteB64 ? Buffer.from(noteB64, 'base64').toString('utf8') : null;
        const parsed = parseAlgocertNote(noteUtf8, tx.sender ?? null);
        const processTs = parsed?.ts ?? null;

        return res.json({
          ok: true,
          txId,
          round: tx['confirmed-round'] ?? null,
          from: tx.sender ?? null,
          to: tx['payment-transaction']?.receiver ?? null,
          noteB64,
          noteUtf8,
          parsed,
          dates: {
            processTs,
            processAtLocal: processTs ? toEcuadorLocal(processTs) : null,
          },
          provider: 'indexer',
        });
      }
    } catch (e) {
      // 2) REST
      try {
        const url = `${INDEXER_URL.replace(/\/+$/, '')}/v2/transactions/${txId}`;
        const r = await fetch(url);
        if (!r.ok) throw new Error(`Indexer REST ${r.status}`);
        const j = await r.json();
        const tx = j?.transaction || null;
        if (tx) {
          const noteB64 = tx.note || null;
          const noteUtf8 = noteB64 ? Buffer.from(noteB64, 'base64').toString('utf8') : null;
          const parsed = parseAlgocertNote(noteUtf8, tx.sender ?? null);
          const processTs = parsed?.ts ?? null;

          return res.json({
            ok: true,
            txId,
            round: tx['confirmed-round'] ?? null,
            from: tx.sender ?? null,
            to: tx['payment-transaction']?.receiver ?? null,
            noteB64,
            noteUtf8,
            parsed,
            dates: {
              processTs,
              processAtLocal: processTs ? toEcuadorLocal(processTs) : null,
            },
            provider: 'indexer-rest',
          });
        }
      } catch (e2) {
        // 3) ALGOD pending (muy reciente)
        try {
          const info = await algodClient.pendingTransactionInformation(txId).do();
          const noteB64 = info?.txn?.txn?.note || null;
          const noteUtf8 = noteB64 ? Buffer.from(noteB64, 'base64').toString('utf8') : null;
          const parsed = parseAlgocertNote(noteUtf8, info?.sender ?? null);
          const processTs = parsed?.ts ?? null;

          return res.json({
            ok: true,
            txId,
            round: info['confirmed-round'] ?? null,
            from: info?.sender ?? null,
            to: info?.['payment-transaction']?.receiver ?? null,
            noteB64,
            noteUtf8,
            parsed,
            dates: {
              processTs,
              processAtLocal: processTs ? toEcuadorLocal(processTs) : null,
            },
            provider: 'algod-pending',
          });
        } catch (e3) {
          throw e2;
        }
      }
    }
    return res.status(404).json({ ok: false, error: 'Transacción no encontrada' });
  } catch (e) {
    console.error('lookup tx by id error:', e);
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

// ---------- Validación directa por HASH (DB → TX → NOTE) ----------
app.get('/api/validate/hash/:hash', async (req, res) => {
  try {
    const hash = (req.params.hash || '').toLowerCase().trim();
    if (!/^[0-9a-f]{64}$/.test(hash)) return res.status(400).json({ error: 'hash inválido (64 hex chars)' });

    const r = await pool.query(
      `SELECT id, hash, txid
         FROM certificados
        WHERE hash = $1
        LIMIT 1`,
      [hash]
    );
    if (r.rowCount === 0) {
      return res.status(404).json({ ok: false, error: 'Hash no encontrado en BD' });
    }

    const row = r.rows[0];
    if (!row.txid) {
      return res.json({
        ok: false,
        pending: true,
        message: 'El hash existe en BD pero aún no tiene txId asociado.',
      });
    }

    const url = `${req.protocol}://${req.get('host')}/api/indexer/tx/${row.txid}`;
    const resp = await fetch(url);
    const data = await resp.json();

    const parsedHash = (data?.parsed?.hash || '').toLowerCase();
    const matches = parsedHash === hash;

    return res.json({
      ok: true,
      matches,
      message: matches
        ? 'El hash coincide con la nota on-chain.'
        : 'La nota on-chain no coincide con el hash.',
      indexer: data,
    });
  } catch (e) {
    console.error('validate/hash error:', e);
    res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

// ---------- Lookup por HASH (v2 y v1; SDK→REST) ----------
app.get('/api/indexer/lookup-by-hash', async (req, res) => {
  try {
    const hashHex = String(req.query.hashHex || '').trim().toLowerCase();
    const wallet  = String(req.query.wallet  || '').trim();
    const role    = String(req.query.role    || '').trim(); // 'receiver' | 'sender' opcional

    const afterHours = req.query.afterHours != null
      ? Math.max(1, Number(req.query.afterHours))
      : IDX_LOOKBACK_HOURS;

    const aheadHours = req.query.aheadHours != null
      ? Math.max(0, Number(req.query.aheadHours))
      : IDX_AHEAD_HOURS;

    if (!/^[0-9a-f]{64}$/.test(hashHex)) {
      return res.status(400).json({ error: 'hashHex inválido (64 hex chars)' });
    }

    const now = Date.now();
    const afterIso  = new Date(now - afterHours * 3600e3).toISOString();
    const beforeIso = new Date(now + aheadHours * 3600e3).toISOString();

    const tryVersion = async (ver) => {
      const prefixUtf8 = `ALGOCERT|${ver}|${hashHex}|`; // pipe final
      const notePrefixBytes = new Uint8Array(Buffer.from(prefixUtf8, 'utf8')); // SDK
      const prefixB64 = Buffer.from(prefixUtf8, 'utf8').toString('base64');    // REST

      // 1) SDK
      try {
        let q = indexerClient
          .searchForTransactions()
          .notePrefix(notePrefixBytes)
          .txType('pay')
          .afterTime(afterIso)
          .beforeTime(beforeIso)
          .limit(10);

        if (algosdk.isValidAddress(wallet)) {
          q = q.address(wallet);
          if (role === 'receiver' || role === 'sender') q = q.addressRole(role);
        }

        const resp = await q.do();
        const txs = resp.transactions || [];
        if (txs.length > 0) {
          txs.sort((a, b) => (b['confirmed-round'] || 0) - (a['confirmed-round'] || 0));
          const tx = txs[0];
          const noteB64 = tx.note || null;
          const noteUtf8 = noteB64 ? Buffer.from(noteB64, 'base64').toString('utf8') : null;
          const parsed = parseAlgocertNote(noteUtf8, tx.sender || null);
          if (parsed) {
            return {
              found: true,
              txId: tx.id,
              round: tx['confirmed-round'] || null,
              from: tx.sender,
              to: tx['payment-transaction']?.receiver || null,
              noteUtf8,
              parsed,
              dates: {
                processTs,
                processAtLocal: processTs ? toEcuadorLocal(processTs) : null,
              },
              provider: 'sdk',
              afterIso,
              beforeIso,
              hours: { afterHours, aheadHours }
            };
          }
        }
      } catch (sdkErr) {
        console.warn('[Indexer SDK] timeout/500, probando fallback REST…', sdkErr?.message || sdkErr);
      }

      // 2) REST
      try {
        const url = new URL(`${INDEXER_URL.replace(/\/+$/,'')}/v2/transactions`);
        url.searchParams.set('note-prefix', prefixB64);
        url.searchParams.set('tx-type', 'pay');
        url.searchParams.set('after-time', afterIso);
        url.searchParams.set('before-time', beforeIso);
        url.searchParams.set('limit', '10');
        if (algosdk.isValidAddress(wallet)) {
          url.searchParams.set('address', wallet);
          if (role === 'receiver' || role === 'sender') url.searchParams.set('address-role', role);
        }

        const r = await fetch(url.toString());
        if (!r.ok) {
          const t = await r.text().catch(()=> '');
          throw new Error(`REST indexer ${r.status}: ${t || r.statusText}`);
        }
        const j = await r.json();
        const txs = j?.transactions || [];
        if (txs.length > 0) {
          txs.sort((a, b) => (b['confirmed-round'] || 0) - (a['confirmed-round'] || 0));
          const tx = txs[0];

          const noteB64 = tx.note || null;
          const noteUtf8 = noteB64 ? Buffer.from(noteB64, 'base64').toString('utf8') : null;
          const parsed = parseAlgocertNote(noteUtf8, tx.sender || null);

          if (parsed) {
            return {
              found: true,
              txId: tx.id,
              round: tx['confirmed-round'] || null,
              from: tx.sender,
              to: tx['payment-transaction']?.receiver || null,
              noteUtf8,
              parsed,
              dates: {
                processTs,
                processAtLocal: processTs ? toEcuadorLocal(processTs) : null,
              },
              provider: 'rest',
              afterIso,
              beforeIso,
              hours: { afterHours, aheadHours }
            };
          }
        }
      } catch (restErr) {
        console.warn('[Indexer REST] fallo/timeout…', restErr?.message || restErr);
      }

      return null;
    };

    // Prueba v2 luego v1 (o al revés si prefieres)
    const versions = ['v2', 'v1'];
    for (const ver of versions) {
      const r = await tryVersion(ver);
      if (r) return res.json(r);
    }

    return res.json({
      found: false,
      afterIso,
      beforeIso,
      hours: { afterHours, aheadHours },
      reason: 'no match or provider timeout'
    });
  } catch (e) {
    console.error('lookup-by-hash error:', e);
    return res.status(500).json({ error: e?.message || String(e) });
  }
});

// ---------- Lookup por NOTE B64 (v1 o v2) ----------
app.get('/api/indexer/lookup-by-b64', async (req, res) => {
  try {
    const b64 = String(req.query.b64 || '').trim().replace(/\s+/g, '');
    const spanDays = Number(req.query.spanDays || 3);
    if (!b64) return res.status(400).json({ error: 'Parámetro b64 requerido' });

    // 1) Decodificar NOTE y parse genérico
    let noteUtf8;
    try {
      noteUtf8 = Buffer.from(b64, 'base64').toString('utf8');
    } catch {
      return res.status(400).json({ error: 'b64 inválido' });
    }
    const parsed0 = parseAlgocertNote(noteUtf8);
    if (!parsed0) {
      return res.status(400).json({ error: 'El note no tiene formato ALGOCERT|v1|... o ALGOCERT|v2|...' });
    }

    const { version, hash: hashHex, wallet: walletFromNote, ts } = parsed0;

    if (!/^[0-9a-f]{64}$/.test(hashHex)) {
      return res.status(400).json({ error: 'hash en note inválido (se esperaban 64 hex chars)' });
    }

    // 2) Prefijo y ventana temporal en función de la versión
    const prefixUtf8 = `ALGOCERT|${version}|${hashHex}|`; // pipe final para selectividad
    const prefixB64 = Buffer.from(prefixUtf8, 'utf8').toString('base64');

    let afterIso, beforeIso;
    if (ts && Number.isFinite(ts)) {
      const base = new Date(ts);
      afterIso  = new Date(base.getTime() - spanDays * 864e5).toISOString();
      beforeIso = new Date(base.getTime() + spanDays * 864e5).toISOString();
    } else {
      afterIso  = new Date(Date.now() - 365 * 864e5).toISOString();
      beforeIso = new Date(Date.now() + 1  * 864e5).toISOString();
    }

    const wallet = String(req.query.wallet || walletFromNote || '').trim();

    // 3) Fallback REST por proveedores
    let lastErr = null;
    for (const base of IDX_CHAIN) {
      try {
        // receiver
        const url1 = buildIdxUrl(base, { b64prefix: prefixB64, wallet, role: 'receiver', limit: 1, afterIso, beforeIso });
        const j1 = await fetchIdx(base, url1);
        let norm = normalizeTxResp(j1);

        // sender
        if (!norm && algosdk.isValidAddress(wallet)) {
          const url2 = buildIdxUrl(base, { b64prefix: prefixB64, wallet, role: 'sender', limit: 1, afterIso, beforeIso });
          const j2 = await fetchIdx(base, url2);
          norm = normalizeTxResp(j2);
        }

        // sin wallet
        if (!norm) {
          const url3 = buildIdxUrl(base, { b64prefix: prefixB64, wallet: '', role: '', limit: 1, afterIso, beforeIso });
          const j3 = await fetchIdx(base, url3);
          norm = normalizeTxResp(j3);
        }

        if (norm) {
          const p = parseAlgocertNote(norm.noteUtf8 || '', norm.from || null);
          return res.json({
            found: true,
            txId: norm.txId,
            round: norm.round,
            from: norm.from,
            to: norm.to,
            noteUtf8: norm.noteUtf8,
            parsed: p,
            provider: base,
            method: 'rest-by-b64',
          });
        }
      } catch (e) {
        lastErr = e;
        continue;
      }
    }

    return res.json({
      found: false,
      tried: IDX_CHAIN,
      noteUtf8,
      reason: lastErr ? String(lastErr.message || lastErr) : 'no match',
    });
  } catch (e) {
    console.error('lookup-by-b64 error:', e);
    return res.status(500).json({ error: e?.message || String(e) });
  }
});

// ---------- start server ----------
app.listen(PORT, () => {
  console.log(`[ALGOD_URL] ${ALGOD_URL}`);
  console.log(`[ALGOD_TOKEN length] ${ALGOD_TOKEN?.length || 0}`);
  console.log(`✅ Backend corriendo en http://localhost:${PORT}`);
});
