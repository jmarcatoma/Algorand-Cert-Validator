// backend/algorand.mjs
import algosdk from 'algosdk';
import dotenv from 'dotenv';
dotenv.config();

function parseServerAndPort(url, defServer, defPort = '') {
  try {
    const u = new URL(url);
    // ej: http://127.0.0.1:4001  => server=http://127.0.0.1  port=4001
    return { server: `${u.protocol}//${u.hostname}`, port: u.port || defPort };
  } catch {
    return { server: defServer, port: defPort };
  }
}

// ALGOD
const ALGOD_URL = process.env.ALGOD_URL || 'http://127.0.0.1:4001';
const ALGOD_TOKEN = process.env.ALGOD_TOKEN || '';
const { server: algodServer, port: algodPort } = parseServerAndPort(ALGOD_URL, 'http://127.0.0.1', '4001');

// token puede ser string o cabeceras; usamos cabecera por comodidad
const algodClient = new algosdk.Algodv2({ 'X-Algo-API-Token': ALGOD_TOKEN }, algodServer, algodPort);

// INDEXER (opcional)
let indexerClient = null;
if (process.env.INDEXER_URL) {
  const { server: indexerServer, port: indexerPort } = parseServerAndPort(process.env.INDEXER_URL, 'http://127.0.0.1', '8980');
  // Indexer no necesita token localmente
  indexerClient = new algosdk.Indexer('', indexerServer, indexerPort);
}

export { algodClient, indexerClient };
