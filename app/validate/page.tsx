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
async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", bytes)
  const arr = Array.from(new Uint8Array(hash))
  return arr.map(b => b.toString(16).padStart(2, "0")).join("")
}

export const IPFS_GATEWAY_BASE =
  (process.env.NEXT_PUBLIC_IPFS_GATEWAY || 'http://192.168.101.194:8080').replace(/\/+$/, '');

export const ALGO_EXPLORER_BASE =
  (process.env.NEXT_PUBLIC_ALGO_EXPLORER_BASE || 'https://explorer.perawallet.app').replace(/\/+$/, '');


type ValidateDetails = {
  filename?: string
  hashHex: string
  wallet?: string | null
  cid?: string | null
  tipo?: string | null
  nombre?: string | null
  txId?: string | null
  round?: number | null
  onchainNoteMatches?: boolean
  ipfsAvailable?: boolean
  version?: "v1" | "v2" | string | null
  // NUEVO:
  processAtLocal?: string | null
}

export default function ValidatePage() {
  const [file, setFile] = useState<File | null>(null)
  const [busy, setBusy] = useState(false)

  const [result, setResult] = useState<{
    valid: boolean
    message: string
    details?: ValidateDetails
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
    try {
      // 1) Calcular hash del PDF
      const bytes = await file.arrayBuffer()
      const hashHex = await sha256Hex(bytes)

      // 2) Backend: DB -> txId -> Indexer (la fecha viene del NOTE via Indexer)
      const resp = await fetch(`http://localhost:4000/api/validate/hash/${hashHex}`)
      const data = await resp.json()

      if (!resp.ok) {
        setResult({
          valid: false,
          message: data?.error || "Error de validación.",
          details: {
            filename: file.name,
            hashHex,
          },
        })
        return
      }

      // ok === true
      const idx = data.indexer || {}
      const parsed = idx.parsed || {}
      const matches = !!data.matches

      const wallet = parsed.wallet || idx.from || null
      const cid = parsed.cid || null
      const txId = idx.txId  || null
      const round = idx.round  ?? null
      const processAtLocal = idx?.dates?.processAtLocal || null

      setResult({
        valid: matches,
        message: data.message || (matches ? "Certificado verificado." : "La nota on-chain no coincide con el hash."),
        details: {
          filename: file.name,
          hashHex,
          wallet,
          cid,
          tipo: parsed.tipo || null,
          nombre: parsed.nombre || null,
          txId,
          round,
          onchainNoteMatches: matches,
          ipfsAvailable: !!cid,
          version: parsed.version || null,
          processAtLocal,
        },
      })
    } catch (e) {
      console.error(e)
      setResult({
        valid: false,
        message: "Error al validar el certificado.",
      })
    } finally {
      setBusy(false)
    }
  }

  const abrirTxEnExplorer = () => {
    const txId = result?.details?.txId;
    if (txId) 
      window.open(`${ALGO_EXPLORER_BASE}/tx/${txId}`, "_blank");
    }

  const abrirEnIPFS = () => {
    const cid = result?.details?.cid;
    if (cid) 
      window.open(`${IPFS_GATEWAY_BASE}/ipfs/${cid}`, "_blank");
  }

  return (
    <div className="container mx-auto px-4 py-12">
      <div className="max-w-3xl mx-auto">
        <h1 className="text-3xl font-bold mb-8 text-center">Validación de Certificados</h1>

        <Card className="mb-8">
          <CardHeader>
            <CardTitle>Sube tu certificado para validar</CardTitle>
            <CardDescription>
              Calcularemos el hash del PDF y lo validaremos consultando la BD (para obtener el txId) y el indexador.
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
              <CardDescription>
                Fuente: Nota on-chain (Indexer)
                {result.details.cid ? " + IPFS" : ""}
                {result.details.version ? ` • ${result.details.version}` : ""}
              </CardDescription>
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

                  {/* v2 */}
                  {result.details.tipo && (
                    <div>
                      <p className="font-medium">Tipo de certificado</p>
                      <p className="text-muted-foreground break-words">{result.details.tipo}</p>
                    </div>
                  )}
                  {result.details.nombre && (
                    <div>
                      <p className="font-medium">Nombre del certificado</p>
                      <p className="text-muted-foreground break-words">{result.details.nombre}</p>
                    </div>
                  )}

                  {/* v1 */}
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
                    <p className="text-muted-foreground break-all">{result.details.txId || "(sin transacción)"}</p>
                  </div>
                  <div>
                    <p className="font-medium">Round confirmado</p>
                    <p className="text-muted-foreground">
                      {typeof result.details.round === "number" ? result.details.round : "(n/d)"}
                    </p>
                  </div>

                  {/* NUEVO: Fecha de proceso (Ecuador) */}
                  {result.details.processAtLocal && (
                    <div className="sm:col-span-2">
                      <p className="font-medium">Fecha de proceso (EC)</p>
                      <p className="text-muted-foreground">{result.details.processAtLocal}</p>
                    </div>
                  )}

                  <div>
                    <p className="font-medium">Note on-chain coincide</p>
                    <p className="text-muted-foreground">{result.details.onchainNoteMatches ? "Sí" : "No"}</p>
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-2 pt-2">
                  {result.details.txId && (
                    <Button
                      type="button"
                      variant="link"
                      className="p-0 h-auto inline-flex items-center gap-2"
                      onClick={abrirTxEnExplorer}
                    >
                      <LinkIcon className="w-4 h-4" /> Ver en AlgoExplorer
                    </Button>
                  )}
                  {result.details.cid && (
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      onClick={abrirEnIPFS}
                      className="inline-flex items-center gap-2"
                    >
                      <Download className="w-4 h-4" /> Abrir en IPFS
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
