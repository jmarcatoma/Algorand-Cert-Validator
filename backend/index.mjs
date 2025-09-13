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

// Convierte cualquier "address-like" en string base32 (WF...)
// Soporta: string, {publicKey: Uint8Array|obj}, {addr:string}
// Reemplaza tu función toAddrString con esta versión mejorada
const toAddrString = (addrLike) => {
  if (!addrLike) return null;
  
  // Caso 1: Ya es un string válido
  if (typeof addrLike === 'string') {
    const cleaned = addrLike.trim();
    return algosdk.isValidAddress(cleaned) ? cleaned : null;
  }

  // Caso 2: Objeto con propiedad addr (string)
  if (addrLike.addr && typeof addrLike.addr === 'string') {
    const cleaned = addrLike.addr.trim();
    return algosdk.isValidAddress(cleaned) ? cleaned : null;
  }

  // Caso 3: Objeto con publicKey (como en tu caso)
  if (addrLike.publicKey) {
    try {
      // Convertir objeto indexado a Uint8Array si es necesario
      const publicKeyBytes = addrLike.publicKey instanceof Uint8Array
        ? addrLike.publicKey
        : new Uint8Array(Object.values(addrLike.publicKey));
      
      // Validar que tenga 32 bytes
      if (publicKeyBytes.length === 32) {
        const addr = algosdk.encodeAddress(publicKeyBytes);
        return algosdk.isValidAddress(addr) ? addr : null;
      }
    } catch (e) {
      console.error('[toAddrString] Error procesando publicKey:', e.message);
      return null;
    }
  }

  // Caso 4: Directamente es un Uint8Array de 32 bytes (clave pública)
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
    const m = (process.env.ALGOD_MNEMONIC || '').trim();
    const words = m.split(/\s+/).filter(Boolean);
    
    console.log(`[DEBUG] Mnemonic words count: ${words.length}`);
    
    if (words.length !== 25) {
      console.warn(`[Signer] ALGOD_MNEMONIC inválido: ${words.length} palabras (deben ser 25)`);
    } else {
      const account = algosdk.mnemonicToSecretKey(words.join(' '));
      
      // Log para debug
      console.log('[DEBUG] Account from mnemonic:', {
        hasAddr: !!account.addr,
        addrType: typeof account.addr,
        addr: account.addr,
        hasSecretKey: !!account.sk
      });
      
      // Asegurar que addr sea un string válido
      if (typeof account.addr === 'string' && algosdk.isValidAddress(account.addr)) {
        serverAcct = account;
        console.log(`[Signer] ✅ Cuenta cargada correctamente: ${serverAcct.addr}`);
      } else {
        // Si addr no es string, intentar convertir desde publicKey
        console.warn('[Signer] addr no es string válido, intentando generar desde publicKey...');
        
        if (account.sk && account.sk.length >= 32) {
          // Extraer la clave pública de los primeros 32 bytes de sk
          const publicKey = account.sk.slice(32, 64);
          const addr = algosdk.encodeAddress(publicKey);
          
          serverAcct = {
            addr: addr,
            sk: account.sk
          };
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
app. get('/api/algod/health', async (req, res) => {
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
    if (!serverAcct) {
      return res.status(501).json({ error: 'Server signer no configurado' });
    }

    let { to, hashHex } = req.body || {};
    to = typeof to === 'string' ? to.trim() : String(to || '').trim();
    hashHex = typeof hashHex === 'string' ? hashHex.trim() : String(hashHex || '').trim();

    // --- Helpers: convierten "algo" en string de dirección válido o lanzan
    const addrToString = (a) => {
      if (!a) return '';
      if (typeof a === 'string') return a.trim();
      if (a.addr && typeof a.addr === 'string') return a.addr.trim();              // por si te mandan {addr:"..."}
      if (a.publicKey) return algosdk.encodeAddress(a.publicKey);                  // Address { publicKey }
      if (a.addr && a.addr.publicKey) return algosdk.encodeAddress(a.addr.publicKey);
      return String(a);
    };

    const canon = (addr) => {
      // fuerza validación: decode → encode (lanza si es inválida)
      return algosdk.encodeAddress(algosdk.decodeAddress(addrToString(addr)).publicKey);
    };

    const fromStr = canon(serverAcct.addr);
    const toStr   = canon(to);

    // --- Nota a partir del hash (hex)
    if (!/^[0-9a-fA-F]+$/.test(hashHex) || (hashHex.length % 2 !== 0)) {
      return res.status(400).json({ error: 'hashHex no es hex válido' });
    }
    const note = new Uint8Array(Buffer.from(hashHex, 'hex'));

    // --- Sugeridos del nodo
    const p = await algodClient.getTransactionParams().do();

    // --- Construir txn (variante soportada en tu SDK)
    const txn = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
      from: serverAcct.addr,     // <- STRING
      to: to,         // <- STRING
      amount: 0,         // 0 ALGO: solo nota
      note,
      suggestedParams: p,
    });

    // Firmar y enviar
    const signed = txn.signTxn(serverAcct.sk);
    const { txId } = await algodClient.sendRawTransaction(signed).do();

    // Confirmación opcional
    const confirmed = await waitForConfirmation(algodClient, txId, 15).catch(() => null);

    return res.json({
      ok: true,
      txId,
      round: confirmed ? confirmed['confirmed-round'] : null,
      from: fromStr,
      to: toStr,
    });
  } catch (e) {
    console.error('anchorNote error:', e);
    return res.status(500).json({ error: e?.message || String(e) });
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
// --- helpers ---
const hexToBase64 = (hex) => Buffer.from(hex, 'hex').toString('base64');

// --- 1) Buscar certificado por hash (en tu Postgres) ---
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
    if (r.rowCount === 0) return res.status(404).json({ error: 'No existe ese hash' });
    res.json(r.rows[0]);
  } catch (e) {
    console.error('by-hash error:', e);
    res.status(500).json({ error: e?.message || String(e) });
  }
});

// --- 2) Descargar el PDF EXACTO desde IPFS por hash ---
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

    // Cabeceras para descarga
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${(nombre_archivo || `documento-${hash.slice(0,8)}`).replace(/"/g,'')}.pdf"`
    );

    // Stream desde IPFS (ipfs.cat devuelve AsyncIterable<Uint8Array>)
    for await (const chunk of ipfs.cat(cid)) {
      res.write(chunk);
    }
    res.end();
  } catch (e) {
    console.error('download error:', e);
    res.status(502).json({ error: 'No se pudo descargar desde IPFS' });
  }
});

// --- (Opcional) HEAD lógico para chequear disponibilidad IPFS por hash ---
app.get('/api/certificadosRedirect/:hash/download', async (req, res) => {
  try {
    const { hash } = req.params;
    const head = String(req.query.head || '').trim() === '1';

    const r = await pool.query(
      `SELECT cid, nombre_archivo FROM certificados WHERE hash = $1 LIMIT 1`,
      [hash]
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'No existe el hash' });

    const { cid, nombre_archivo } = r.rows[0];
    if (!cid) return res.status(404).json({ error: 'El certificado no tiene CID' });

    if (head) {
      // Respuesta rápida de "disponible"
      return res.json({ ok: true, cid });
    }

    // Si ya tienes tu cliente IPFS (const ipfs = create({...})) puedes streamear:
    // const stream = ipfs.cat(cid);
    // res.setHeader('Content-Type', 'application/pdf');
    // res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(nombre_archivo || 'certificado.pdf')}"`);
    // for await (const chunk of stream) {
    //   res.write(chunk);
    // }
    // return res.end();

    // Si prefieres gateway interno/exterior, puedes proxy:
    return res.redirect(`http://192.168.101.194:9095/ipfs/${cid}`); // ajusta a tu cluster/gateway
  } catch (e) {
    console.error('download error:', e);
    res.status(500).json({ error: e?.message || String(e) });
  }
});

// --- 3) Verificar on-chain usando un indexer público (Algonode) por hash ---
app.get('/api/verify/hash/:hash', async (req, res) => {
  try {
    const { hash } = req.params;
    if (!/^[0-9a-fA-F]+$/.test(hash) || hash.length % 2 !== 0) {
      return res.status(400).json({ error: 'hash inválido' });
    }
    const b64 = hexToBase64(hash);

    // Busca por note-prefix en el indexer público (MainNet)
    const url = `https://mainnet-idx.algonode.cloud/v2/transactions?limit=1&note-prefix=${encodeURIComponent(b64)}`;
    const r = await fetch(url);
    if (!r.ok) {
      return res.status(502).json({ error: 'Fallo indexer público', status: r.status });
    }
    const j = await r.json().catch(() => ({}));
    const txs = j?.transactions || [];
    const tx = txs[0];

    const valid = !!tx;
    res.json({
      valid,
      txId: tx?.id || null,
      round: tx?.['confirmed-round'] || null,
      from: tx?.sender || null,
      // el "note" viene en base64; lo devolvemos para que puedas cotejar si quieres
      noteB64: tx?.note || null,
      // por conveniencia devolvemos el mismo hash consultado
      hash
    });
  } catch (e) {
    console.error('verify/hash error:', e);
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

// --- Obtener info de una transacción por txId (Algod) ---
app.get('/api/algod/tx/:txId', async (req, res) => {
  try {
    const { txId } = req.params;
    const info = await algodClient.pendingTransactionInformation(txId).do();
    // Por si alguna lib mete BigInt en el futuro:
    const safe = JSON.parse(JSON.stringify(info, (_, v) => (typeof v === 'bigint' ? Number(v) : v)));
    res.json(safe);
  } catch (e) {
    console.error('tx-info error:', e);
    res.status(500).json({ error: e?.message || String(e) });
  }
});


// ---------- start server (ÚNICO listen) ----------
app.listen(PORT, () => {
  console.log(`[ALGOD_URL] ${ALGOD_URL}`);
  console.log(`[ALGOD_TOKEN length] ${ALGOD_TOKEN?.length || 0}`);
  console.log(`✅ Backend corriendo en http://localhost:${PORT}`);
});

