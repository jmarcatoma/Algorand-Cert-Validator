"use client"

import type React from "react"
import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { AlertCircle, CheckCircle2, Upload, Link as LinkIcon, Download } from "lucide-react"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"

// Helpers
async function fileToArrayBuffer(file: File): Promise<ArrayBuffer> {
  return await file.arrayBuffer()
}

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", bytes)
  const arr = Array.from(new Uint8Array(hash))
  return arr.map(b => b.toString(16).padStart(2, "0")).join("")
}

function b64ToBytes(b64: string): Uint8Array {
  // atob en navegador
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

export default function ValidatePage() {
  const [file, setFile] = useState<File | null>(null)
  const [busy, setBusy] = useState(false)

  const [result, setResult] = useState<{
    valid: boolean
    message: string
    details?: {
      filename?: string
      hashHex: string
      wallet?: string
      cid?: string
      txId?: string
      round?: number | null
      onchainNoteMatches?: boolean
      ipfsAvailable?: boolean
    }
  } | null>(null)

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      setFile(e.target.files[0])
      setResult(null)
    }
  }

  const validateCertificate = async () => {
    if (!file) return
    setBusy(true)
    setResult(null)
    try {
      // 1) Hash del PDF
      const bytes = await fileToArrayBuffer(file)
      const hashHex = await sha256Hex(bytes)

      // 2) Buscar en BD por hash
      const r1 = await fetch(`http://localhost:4000/api/certificados/by-hash/${hashHex}`)
      if (!r1.ok) {
        setResult({
          valid: false,
          message: "El hash del PDF no está registrado en la base de datos.",
          details: { hashHex }
        })
        setBusy(false)
        return
      }
      const row = await r1.json() // {hash, cid, txid, wallet, round, ...}

      // 3) Chequear IPFS (head lógico)
      let ipfsAvailable = false
      try {
        const head = await fetch(`http://localhost:4000/api/certificados/${hashHex}/download?head=1`)
        ipfsAvailable = head.ok
      } catch {
        ipfsAvailable = false
      }

      // 4) Si hay txId, verificar on-chain que la note == hashHex
      let onchainNoteMatches = false
      let round: number | null = row.round ?? null
      if (row.txid) {
        try {
          const r2 = await fetch(`http://localhost:4000/api/algod/tx/${row.txid}`)
          if (r2.ok) {
            const txinfo = await r2.json()
            // En Algorand la note viene base64 en txinfo.note
            const noteB64 =
              txinfo?.noteB64 ||
              txinfo?.txn?.txn?.note ||
              txinfo?.transaction?.note ||
              txinfo?.note ||
              null;

            if (typeof noteB64 === "string" && noteB64.length > 0) {
              const noteBytes = b64ToBytes(noteB64)
              const noteHex = Array.from(noteBytes).map(b => b.toString(16).padStart(2, "0")).join("")
              onchainNoteMatches = (noteHex.toLowerCase() === hashHex.toLowerCase())
            }
            // Confirmed round (si lo aporta el nodo)
            round = typeof txinfo["confirmed-round"] === "number" ? txinfo["confirmed-round"] : round
          }
        } catch {
          // ignoramos errores de red aquí
        }
      }

      // 5) Componer resultado
      const overallValid = !!row && (!!row.txid ? onchainNoteMatches : true)

      setResult({
        valid: overallValid,
        message: overallValid
          ? "El certificado coincide con el registro en BD y fue verificado en Algorand."
          : (row.txid
              ? "El certificado existe en BD, pero la nota on-chain no coincide con el hash del PDF."
              : "El certificado existe en BD, pero no hay transacción asociada."),
        details: {
          filename: row.nombre_archivo,
          hashHex,
          wallet: row.wallet,
          cid: row.cid,
          txId: row.txid ?? undefined,
          round: round ?? null,
          ipfsAvailable,
          onchainNoteMatches
        }
      })
    } catch (e: any) {
      setResult({
        valid: false,
        message: `Error durante la validación: ${e?.message || String(e)}`
      })
    } finally {
      setBusy(false)
    }
  }

  const descargarDesdeBackend = () => {
    if (!result?.details?.hashHex) return
    window.open(`http://localhost:4000/api/certificados/${result.details.hashHex}/download`, "_blank")
  }

  return (
    <div className="container mx-auto px-4 py-12">
      <div className="max-w-3xl mx-auto">
        <h1 className="text-3xl font-bold mb-8 text-center">Validación de Certificados</h1>

        <Card className="mb-8">
          <CardHeader>
            <CardTitle>Sube tu certificado para validar</CardTitle>
            <CardDescription>
              Verificaremos el PDF contra la base de datos (hash/IPFS) y la blockchain de Algorand (nota de la transacción).
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid w-full items-center gap-4">
              <div className="flex flex-col space-y-1.5">
                <Label htmlFor="certificate">Archivo de Certificado (PDF)</Label>
                <div className="flex items-center gap-2">
                  <Input id="certificate" type="file" accept=".pdf" onChange={handleFileChange} />
                </div>
              </div>
            </div>
          </CardContent>
          <CardFooter>
            <Button className="w-full" onClick={validateCertificate} disabled={!file || busy}>
              <Upload className="mr-2 h-4 w-4" /> {busy ? "Validando..." : "Validar Certificado"}
            </Button>
          </CardFooter>
        </Card>

        {result && (
          <Alert variant={result.valid ? "default" : "destructive"}>
            {result.valid ? <CheckCircle2 className="h-4 w-4" /> : <AlertCircle className="h-4 w-4" />}
            <AlertTitle>{result.valid ? "Certificado Válido" : "Certificado Inválido"}</AlertTitle>
            <AlertDescription>{result.message}</AlertDescription>
          </Alert>
        )}

        {result?.details && (
          <Card className="mt-8">
            <CardHeader>
              <CardTitle>Detalles verificados</CardTitle>
              <CardDescription>Fuente: BD/IPFS + nodo Algorand</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="space-y-4 text-sm">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <p className="font-medium">Archivo</p>
                    <p className="text-muted-foreground break-words">{result.details.filename || "(sin nombre)"}</p>
                  </div>
                  <div>
                    <p className="font-medium">Wallet asociada</p>
                    <p className="text-muted-foreground break-words">{result.details.wallet || "(n/d)"}</p>
                  </div>
                  <div className="sm:col-span-2">
                    <p className="font-medium">Hash (SHA-256)</p>
                    <p className="text-muted-foreground font-mono break-all">{result.details.hashHex}</p>
                  </div>
                  <div>
                    <p className="font-medium">CID (IPFS)</p>
                    <p className="text-muted-foreground break-words">{result.details.cid || "(n/d)"}</p>
                  </div>
                  <div>
                    <p className="font-medium">IPFS disponible</p>
                    <p className="text-muted-foreground">{result.details.ipfsAvailable ? "Sí" : "No"}</p>
                  </div>
                  <div>
                    <p className="font-medium">TxID</p>
                    <p className="text-muted-foreground break-all">
                      {result.details.txId || "(sin transacción)"}
                    </p>
                  </div>
                  <div>
                    <p className="font-medium">Round confirmado</p>
                    <p className="text-muted-foreground">{typeof result.details.round === "number" ? result.details.round : "(n/d)"}</p>
                  </div>
                  <div>
                    <p className="font-medium">Note on-chain coincide</p>
                    <p className="text-muted-foreground">{result.details.onchainNoteMatches ? "Sí" : "No"}</p>
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-2 pt-2">
                  {result.details.txId && (
                    <a
                      href={`https://algoexplorer.io/tx/${result.details.txId}`}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-2 text-blue-600 underline"
                    >
                      <LinkIcon className="w-4 h-4" /> Ver en AlgoExplorer (MainNet)
                    </a>
                  )}
                  {result.details.hashHex && (
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      onClick={descargarDesdeBackend}
                      className="inline-flex items-center gap-2"
                    >
                      <Download className="w-4 h-4" /> Descargar PDF (IPFS/Backend)
                    </Button>
                  )}
                </div>
              </div>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  )
}
