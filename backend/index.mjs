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


const algodClient = new algosdk.Algodv2(ALGOD_TOKEN, ALGOD_URL, ALGOD_PORT);
const MNEMONIC = process.env.ALGOD_MNEMONIC;

let serverAcct = null;
if (MNEMONIC) {
  try {
    serverAcct = algosdk.mnemonicToSecretKey(MNEMONIC);
    console.log('[ANCHOR address]', serverAcct.addr);
  } catch (e) {
    console.warn('[ANCHOR] MNEMONIC inválido:', e?.message || String(e));
  }
} else {
  console.warn('[ANCHOR] Falta ALGOD_MNEMONIC en .env; /api/algod/anchorNote deshabilitado');
}


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

// ---------- INDEXER placeholder (lo activaremos después) ----------
let indexerClient = null;

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
  const { wallet, hash, txid, round } = req.body;
  const file = req.file;

  if (!file || !wallet || !hash) {
    return res.status(400).json({ error: 'Faltan datos requeridos' });
  }

  try {
    // ¿ya existe el hash?
    const existe = await pool.query('SELECT 1 FROM certificados WHERE hash = $1', [hash]);
    if (existe.rows.length > 0) {
      fs.unlinkSync(file.path);
      return res.status(409).json({ error: 'Hash ya registrado' });
    }

    // Subir a IPFS
    const buffer = fs.readFileSync(file.path);
    const result = await ipfs.add(buffer);
    const cid = result.cid.toString();

    // Guardar en BD con txid/round si nos los pasaron
    await pool.query(
      `INSERT INTO certificados (wallet, nombre_archivo, hash, cid, txid, round)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [wallet, file.originalname, hash, cid, txid || null, round ? Number(round) : null]
    );

    fs.unlinkSync(file.path);
    res.json({ message: 'Título guardado exitosamente', cid, txid: txid || null, round: round || null });
  } catch (err) {
    console.error('❌ Error al guardar título:', err);
    res.status(500).json({ error: 'Error interno al guardar título' });
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

// ---------- ALGOD: status (útil para ver sync/catchup) ----------
app.get('/api/algod/status', async (_req, res) => {
  try {
    const st = await algodClient.status().do();
    res.json({
      lastRound: st['last-round'],
      timeSinceLastRound: st['time-since-last-round'],
      catchupTime: st['catchup-time'] ?? null,
      lastCatchpoint: st['catchpoint'] ?? null,
    });
  } catch (e) {
    res.status(500).json({ error: e?.message || String(e) });
  }
});

// ---------- ALGOD: suggested params ----------
app.get('/api/algod/params', async (req, res) => {
  try {
    const params = await algodClient.getTransactionParams().do();
    const safe = toJSONSafe(params); // <-- aquí convertimos BigInt -> string
    res.json(safe);
  } catch (e) {
    res.status(500).json({ error: e?.message || String(e) });
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
  // Lo activaremos cuando montemos Indexer V2.
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
    // confirmed-round presente si ya fue confirmada
    res.json({
      txId,
      confirmedRound: info['confirmed-round'] ?? null,
      poolError: info['pool-error'] || null
    });
  } catch (e) {
    res.status(500).json({ error: e?.message || String(e) });
  }
});

// ---------- ALGOD: anclar nota (server-signer) ----------
app.post('/api/algod/anchorNote', express.json(), async (req, res) => {
  try {
    if (!serverAcct) return res.status(501).json({ error: 'Server signer no configurado' });
    const { to, hashHex } = req.body || {};
    if (!to || !hashHex) return res.status(400).json({ error: 'Faltan to o hashHex' });

    const note = new Uint8Array(Buffer.from(String(hashHex), 'hex'));
    const params = await algodClient.getTransactionParams().do();

    const txn = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
      from: serverAcct.addr,
      to,
      amount: 0,         // 0 ALGO, solo nota
      note,
      suggestedParams: params,
    });

    const signed = txn.signTxn(serverAcct.sk);
    const { txId } = await algodClient.sendRawTransaction(signed).do();

    // Espera confirmación unos segundos (opcional)
    const confirmed = await waitForConfirmation(algodClient, txId, 15);
    res.json({
      txId,
      round: confirmed ? confirmed['confirmed-round'] : null,
    });
  } catch (e) {
    console.error('anchorNote error', e);
    res.status(500).json({ error: e?.message || String(e) });
  }
});

// ---------- BD: adjuntar txid/round a un certificado por hash ----------
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


// ---------- start server (ÚNICO listen) ----------
app.listen(PORT, () => {
  console.log(`[ALGOD_URL] ${ALGOD_URL}`);
  console.log(`[ALGOD_TOKEN length] ${ALGOD_TOKEN?.length || 0}`);
  console.log(`✅ Backend corriendo en http://localhost:${PORT}`);
});

