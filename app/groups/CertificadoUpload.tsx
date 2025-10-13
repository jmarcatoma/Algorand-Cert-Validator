"use client"

import { useState } from "react"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { Card, CardHeader, CardTitle, CardDescription, CardFooter, CardContent } from "@/components/ui/card"
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter
} from "@/components/ui/alert-dialog"
import { Upload, X, Download, Link as LinkIcon } from "lucide-react"

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", bytes)
  const arr = Array.from(new Uint8Array(hash))
  return arr.map(b => b.toString(16).padStart(2, "0")).join("")
}

const API_BASE = (process.env.NEXT_PUBLIC_API_BASE || "http://localhost:4000").replace(/\/+$/, "")
const ALGO_EXPLORER_BASE = (process.env.NEXT_PUBLIC_ALGO_EXPLORER_BASE || "https://explorer.perawallet.app").replace(/\/+$/, "")
const IPFS_GATEWAY_BASE = (process.env.NEXT_PUBLIC_IPFS_GATEWAY || "http://192.168.101.194:8080").replace(/\/+$/, "")

type AlertKind = null | "success" | "duplicate" | "error"

export default function CertificadoUpload({ wallet }: { wallet: string }) {
  const [file, setFile] = useState<File | null>(null)
  const [hash, setHash] = useState<string | null>(null)
  const [alertType, setAlertType] = useState<AlertKind>(null)
  const [cid, setCid] = useState<string>("")
  const [tipo, setTipo] = useState<string>("")
  const [nombreCert, setNombreCert] = useState<string>("") // dueño (v2 usa 'nombre' como dueño)
  const [anchoring, setAnchoring] = useState(false)
  const [txId, setTxId] = useState<string>("")
  const [round, setRound] = useState<number | null>(null)
  const [confirmedBy, setConfirmedBy] = useState<'algod' | 'indexer-sdk' | 'indexer-rest' | 'unknown' | null>(null)
  const [pending, setPending] = useState(false)
  

  const calcularHash = async (f: File) => {
    const buffer = await f.arrayBuffer()
    return await sha256Hex(buffer)
  }

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]
    if (!f) {
      setFile(null)
      setHash(null)
      return
    }
    setFile(f)
    const h = await calcularHash(f)
    setHash(h.toLowerCase())
  }

  const descargar = () => {
    if (!hash) return
    //window.open(`${API_BASE}/api/certificados/${hash}/download`, "_blank")
    window.open(`${API_BASE}/api/download/by-hash/${hash}`, "_blank")

  }

  const abrirExplorer = () => {
    if (txId) window.open(`${ALGO_EXPLORER_BASE}/tx/${txId}`, "_blank")
  }

  const abrirIpfs = () => {
    if (cid) window.open(`${IPFS_GATEWAY_BASE}/ipfs/${cid}`, "_blank")
  }

  const handleSubmit = async () => {
    if (!file || !wallet || !hash) return
    const tipoClean = tipo.trim()
    const duenoClean = nombreCert.trim().toUpperCase()

    if (!tipoClean || !duenoClean) {
      alert("Completa 'Tipo de certificado' y 'Dueño del certificado'")
      return
    }

    const formData = new FormData()
    formData.append("file", file)
    formData.append("wallet", wallet) // requerido por tu backend /subir-certificado
    formData.append("hash", hash)

    try {
      // 1) Subir a IPFS + BD (según tu backend actual)
      const res = await fetch(`${API_BASE}/subir-certificado`, {
        method: "POST",
        body: formData,
      })

      if (res.status === 409) {
        setAlertType(null)
        setTimeout(() => setAlertType("duplicate"), 10)
        return
      }

      if (!res.ok) {
        console.error("subir-certificado error", await res.text().catch(() => ""))
        setAlertType("error")
        return
      }

      const data = await res.json()
      const pdfCid = data?.cid || ""
      setCid(pdfCid)

      // 2) Anclar NOTE v2 (usa 'to': wallet) – backend espera 'nombreCert'
      try {
        setAnchoring(true)
        const anchorRes = await fetch(`${API_BASE}/api/algod/anchorNoteUpload`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            to: wallet,              // requerido por backend actual
            hashHex: hash,           // 64 hex
            cid: pdfCid,
            tipo: tipoClean,         // tipo de certificado
            nombreCert: duenoClean,  // dueño (compat con backend actual)
            filename: file.name,     // opcional
          }),
        })

        const ajson = await anchorRes.json().catch(() => ({} as any))

        if (anchorRes.ok && ajson.txId) {
          setTxId(ajson.txId)
          setRound(ajson.round ?? null)
          setConfirmedBy(ajson.confirmedBy || null)
          setPending(!ajson.round)

          // 3) (Opcional) Adjuntar tx a BD
          try {
            const attach = await fetch(`${API_BASE}/api/certificados/${hash}/attach-tx`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ txId: ajson.txId, round: ajson.round ?? null }),
            })
            if (!attach.ok) {
              console.warn("attach-tx no OK:", await attach.text().catch(() => ""))
            }
          } catch (e) {
            console.warn("attach-tx error:", e)
          }

          // 4) Publicar en índice IPFS (Opción B)
          try {
            const pub = await fetch(`${API_BASE}/api/index/publish-hash`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                hash,
                pdf_cid: pdfCid,
                txid: ajson.txId,
                wallet,                                // opcional en meta
                timestamp: new Date().toISOString(),
                title: tipoClean,                       // guardamos el tipo
                owner_name: duenoClean,                 // dueño (normalizable en backend)
              }),
            })
            if (!pub.ok) {
              console.warn("publish-hash NO OK:", await pub.text().catch(() => ""))
            }
          } catch (e) {
            console.warn("publish-hash error:", e)
          }

          setAlertType("success")
        } else {
          console.error("anchor v2 error", ajson)
          setAlertType("error")
        }
      } catch (err) {
        console.error("anchor network error", err)
        setAlertType("error")
      } finally {
        setAnchoring(false)
      }
    } catch (err) {
      console.error("❌ Error al subir:", err)
      setAlertType("error")
    }
  }

  return (
    <div className="container mx-auto px-4 py-12 max-w-2xl">
      <Card>
        <CardHeader>
          <CardTitle>Subir Certificados (v2)</CardTitle>
          <CardDescription>
            Carga un PDF, ancla en Algorand con <b>dueño</b> y <b>tipo</b>, y publica metadatos en índice IPFS para búsquedas.
          </CardDescription>
        </CardHeader>

        <CardContent className="grid gap-4">
          <Input type="file" accept=".pdf" onChange={handleFileChange} />
          <Input
            placeholder="Dueño del certificado (nombre completo)"
            value={nombreCert}
            onChange={(e) => setNombreCert(e.target.value)}
          />
          <Input
            placeholder="Tipo de certificado (p. ej. Certificado de Curso)"
            value={tipo}
            onChange={(e) => setTipo(e.target.value)}
          />

          {hash && (
            <div className="text-sm text-muted-foreground break-words">
              <div>
                <span className="font-semibold">Hash:</span>{" "}
                <span className="font-mono">{hash}</span>
              </div>
            </div>
          )}
        </CardContent>

        <CardFooter className="flex items-center gap-3">
          <Button variant="outline" onClick={descargar} disabled={!hash}>
            <Download className="w-4 h-4" /> Descargar PDF (IPFS/Backend)
          </Button>
          {txId && (
            <Button variant="link" className="p-0 h-auto inline-flex items-center gap-2" onClick={abrirExplorer}>
              <LinkIcon className="w-4 h-4" /> Ver en AlgoExplorer
            </Button>
          )}
          {cid && (
            <Button variant="secondary" onClick={abrirIpfs}>
              Abrir en IPFS
            </Button>
          )}
          <div className="ml-auto">
            <Button onClick={handleSubmit} disabled={!file || anchoring}>
              <Upload className="mr-2 h-4 w-4" /> {anchoring ? "Anclando…" : "Subir y Anclar (v2)"}
            </Button>
          </div>
        </CardFooter>
      </Card>

      <AlertDialog open={alertType !== null} onOpenChange={() => setAlertType(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {alertType === "success"
                ? "✅ Certificado registrado y anclado con éxito"
                : alertType === "duplicate"
                ? "⚠️ Certificado ya existente"
                : "❌ Ocurrió un problema"}
            </AlertDialogTitle>

            {/* 👇👇 FIX: usar asChild para que no renderice <p>, así podemos usar <div> dentro */}
            <AlertDialogDescription asChild>
              <div className="text-sm text-muted-foreground break-words space-y-2">
                {alertType === "success" && (
                  <>
                    {cid && (
                      <div>
                        <b>CID:</b> <span className="font-mono">{cid}</span>
                      </div>
                    )}
                    {txId && (
                      <div>
                        <b>TxID:</b> <span className="font-mono">{txId}</span>
                      </div>
                    )}
                    {typeof round === "number" && (
                      <div className="text-sm">
                        <b>Round:</b> {round}
                        {confirmedBy && (
                          <> <span className="mx-2">•</span>
                            <span className="italic">
                              confirmado por {confirmedBy === 'algod' ? 'Algod' :
                                              confirmedBy === 'indexer-sdk' ? 'Indexer (SDK)' :
                                              confirmedBy === 'indexer-rest' ? 'Indexer (REST)' : '—'}
                            </span>
                          </>
                        )}
                      </div>
                    )}
                    {pending && <div className="text-amber-600 text-sm">Aún pendiente de confirmación…</div>}

                  </>
                )}
                {alertType === "duplicate" && (
                  <div>Ya existe un registro con este hash.</div>
                )}
                {alertType === "error" && (
                  <div>Revisa la conexión y los datos. Si persiste, revisa logs del backend.</div>
                )}
              </div>
            </AlertDialogDescription>
            {/* ☝️☝️ con asChild evitamos <div> dentro de <p> */}
          </AlertDialogHeader>

          <AlertDialogFooter>
            <Button onClick={() => setAlertType(null)}>
              <X className="w-4 h-4" /> Cerrar
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
