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

// Asegura padding del base64 (por si falta "==" al final)
function fixBase64(s: string) {
  let t = s.trim().replace(/\s+/g, "")
  const pad = t.length % 4
  if (pad) t = t + "=".repeat(4 - pad)
  return t
}

export default function ValidatePage() {
  const [file, setFile] = useState<File | null>(null)
  const [busy, setBusy] = useState(false)

  // Nuevos filtros opcionales
  const [walletHint, setWalletHint] = useState("")
  const [noteB64, setNoteB64] = useState("")
  const [spanDays, setSpanDays] = useState<number>(3) // ventana ±3 días para /lookup-by-b64

  const [result, setResult] = useState<{
    valid: boolean
    message: string
    details?: {
      filename?: string
      hashHex: string
      wallet?: string | null
      cid?: string | null
      txId?: string | null
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
    try {
      // 1) Calcular hash del PDF
      const bytes = await file.arrayBuffer()
      const hashHex = await sha256Hex(bytes)

      let data: any

      // 2) Si el usuario pegó el noteB64 -> usar /lookup-by-b64 (rápido)
      if (noteB64.trim()) {
        const b64Fixed = encodeURIComponent(fixBase64(noteB64))
        const resp = await fetch(
          `http://localhost:4000/api/indexer/lookup-by-b64?b64=${b64Fixed}&spanDays=${spanDays}`
        )
        data = await resp.json()
      } else {
        // 3) Si NO hay noteB64 -> usar /lookup-by-hash, acotando (wallet/role/afterDays)
        const u = new URL("http://localhost:4000/api/indexer/lookup-by-hash")
        u.searchParams.set("hashHex", hashHex)
        if (walletHint.trim()) {
          u.searchParams.set("wallet", walletHint.trim())
          u.searchParams.set("role", "receiver")
          u.searchParams.set("afterDays", "30") // ventana razonable si conoces la wallet
        } else {
          u.searchParams.set("afterDays", "365") // fallback si no conoces wallet
        }
        const resp = await fetch(u.toString())
        data = await resp.json()
      }

      if (!data?.found) {
        setResult({
          valid: false,
          message:
            "No se encontró transacción con un note que empiece con ALGOCERT|v1|<hash> en la ventana indicada.",
          details: {
            filename: file.name,
            hashHex,
            wallet: null,
            cid: null,
            txId: null,
            round: null,
            onchainNoteMatches: false,
            ipfsAvailable: false,
          },
        })
        return
      }

      const parsedHash = (data.parsed?.hash || "").toLowerCase()
      const matches = parsedHash === hashHex.toLowerCase()

      setResult({
        valid: matches,
        message: matches
          ? "El hash del PDF coincide con la nota on-chain. Certificado verificado."
          : "La nota on-chain no coincide con el hash calculado del PDF.",
        details: {
          filename: file.name,
          hashHex,
          wallet: data.parsed?.wallet || data.from || null,
          cid: data.parsed?.cid || null,
          txId: data.txId || null,
          round: data.round ?? null,
          onchainNoteMatches: matches,
          ipfsAvailable: !!data.parsed?.cid,
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
    const txId = result?.details?.txId
    if (txId) window.open(`https://algoexplorer.io/tx/${txId}`, "_blank")
  }

  const abrirEnIPFS = () => {
    const cid = result?.details?.cid
    if (cid) window.open(`https://ipfs.io/ipfs/${cid}`, "_blank")
  }

  return (
    <div className="container mx-auto px-4 py-12">
      <div className="max-w-3xl mx-auto">
        <h1 className="text-3xl font-bold mb-8 text-center">Validación de Certificados</h1>

        <Card className="mb-8">
          <CardHeader>
            <CardTitle>Sube tu certificado para validar</CardTitle>
            <CardDescription>
              Verificaremos el PDF calculando su hash y comparándolo con la nota on-chain (Algorand Indexer).
              Si pegas el <strong>note en base64</strong> o indicas la <strong>wallet receptora</strong>, la búsqueda será más rápida.
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

              {/* Campos opcionales para acotar la búsqueda */}
              <div className="flex flex-col space-y-1.5">
                <Label htmlFor="walletHint">Wallet (receptor, opcional)</Label>
                <Input
                  id="walletHint"
                  placeholder="WF7545X4CNPWV2... (opcional)"
                  value={walletHint}
                  onChange={(e) => setWalletHint(e.target.value)}
                />
              </div>

              <div className="flex flex-col space-y-1.5">
                <Label htmlFor="noteB64">Note (base64, opcional)</Label>
                <Input
                  id="noteB64"
                  placeholder="Pega el note en base64 si lo tienes"
                  value={noteB64}
                  onChange={(e) => setNoteB64(e.target.value)}
                />
                <div className="text-xs text-muted-foreground">
                  Si pegas el note base64, se usará búsqueda por prefix exacto y ventana temporal para evitar timeouts.
                </div>
              </div>

              <div className="flex items-center gap-2">
                <Label htmlFor="spanDays" className="whitespace-nowrap">
                  Ventana ±días
                </Label>
                <Input
                  id="spanDays"
                  type="number"
                  min={1}
                  max={30}
                  className="w-24"
                  value={spanDays}
                  onChange={(e) => setSpanDays(Number(e.target.value) || 3)}
                />
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
              <CardDescription>Fuente: Nota on-chain (Indexer) {result.details.cid ? "+ IPFS" : ""}</CardDescription>
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
                    <p className="text-muted-foreground break-all">{result.details.txId || "(sin transacción)"}</p>
                  </div>
                  <div>
                    <p className="font-medium">Round confirmado</p>
                    <p className="text-muted-foreground">
                      {typeof result.details.round === "number" ? result.details.round : "(n/d)"}
                    </p>
                  </div>
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
