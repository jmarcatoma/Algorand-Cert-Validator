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
import { Upload, X } from "lucide-react"

// Helpers
async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", bytes)
  const arr = Array.from(new Uint8Array(hash))
  return arr.map(b => b.toString(16).padStart(2, "0")).join("")
}

export default function CertificadoUpload({ wallet }: { wallet: string }) {
  const [file, setFile] = useState<File | null>(null)
  const [hash, setHash] = useState<string | null>(null)
  const [alertType, setAlertType] = useState<null | "success" | "duplicate" | "error">(null)
  const [cid, setCid] = useState<string>("")
  const [tipo, setTipo] = useState<string>("")
  const [nombreCert, setNombreCert] = useState<string>("")
  const [anchoring, setAnchoring] = useState(false)
  const [txId, setTxId] = useState<string>("")
  const [round, setRound] = useState<number | null>(null)

  const calcularHash = async (file: File) => {
    const buffer = await file.arrayBuffer()
    const hashBuffer = await crypto.subtle.digest("SHA-256", buffer)
    const hashArray = Array.from(new Uint8Array(hashBuffer))
    return hashArray.map(b => b.toString(16).padStart(2, "0")).join("")
  }

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]
    if (!f) return
    if (f.type !== "application/pdf") {
      alert("Solo se permiten archivos PDF")
      return
    }
    setFile(f)
    const h = await calcularHash(f)
    setHash(h)
  }

  const handleSubmit = async () => {
    if (!file || !wallet || !hash) return
    if (!tipo.trim() || !nombreCert.trim()) {
      alert("Completa 'Tipo de certificado' y 'Nombre del certificado'")
      return
    }

    const formData = new FormData()
    formData.append("file", file)
    formData.append("wallet", wallet)
    formData.append("hash", hash)

    try {
      // 1) IPFS + BD
      const res = await fetch("http://localhost:4000/subir-certificado", {
        method: "POST",
        body: formData,
      })

      if (res.status === 409) {
        // Hash duplicado en BD
        setAlertType(null)
        setTimeout(() => setAlertType("duplicate"), 10)
        return
      }

      if (!res.ok) throw new Error("Error al subir a IPFS/BD")

      const data = await res.json()
      setCid(data.cid || "")

      // 2) Anchor en Algorand (v2: hash + tipo + nombre + wallet + ts)
      try {
        setAnchoring(true)
        const body = {
          to: wallet,
          hashHex: hash,
          cid: data.cid,
          filename: file.name,
          tipo: tipo.trim(),
          nombreCert: nombreCert.trim(),
        }
        const anchorRes = await fetch("http://localhost:4000/api/algod/anchorNoteUpload", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        })
        const ajson = await anchorRes.json().catch(() => ({}))

        if (anchorRes.ok && ajson.txId) {
          setTxId(ajson.txId || "")
          setRound(ajson.round ?? null)

          // 3) Adjuntar txId/round a la BD (por hash)
          try {
            const attach = await fetch(`http://localhost:4000/api/certificados/${hash}/attach-tx`, {
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
    <>
      <Card className="max-w-xl mx-auto mt-6">
        <CardHeader>
          <CardTitle>Subir Certificado</CardTitle>
          <CardDescription>
            Sube un PDF para registrar en IPFS y anclar en Algorand con tipo y nombre (formato ALGOCERT v2).
          </CardDescription>
        </CardHeader>

        <CardContent className="space-y-4">
          <div className="space-y-2">
            <label className="text-sm font-medium">Archivo PDF</label>
            <Input type="file" accept="application/pdf" onChange={handleFileChange} />
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium">Tipo de certificado</label>
            <Input
              placeholder="p.ej., Certificado de Asistencia"
              value={tipo}
              onChange={(e) => setTipo(e.target.value)}
            />
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium">Nombre del certificado</label>
            <Input
              placeholder="p.ej., Taller de Introducción a Blockchain"
              value={nombreCert}
              onChange={(e) => setNombreCert(e.target.value)}
            />
          </div>

          {hash && <p className="text-sm mt-2 break-words text-muted-foreground">Hash SHA-256: {hash}</p>}
        </CardContent>

        <CardFooter className="flex justify-end">
          <Button onClick={handleSubmit} disabled={!file || anchoring}>
            <Upload className="w-4 h-4" />
            {anchoring ? "Anclando…" : "Subir y Anclar"}
          </Button>
        </CardFooter>
      </Card>

      <AlertDialog open={!!alertType} onOpenChange={() => setAlertType(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {alertType === "success"
                ? "✅ Certificado registrado y anclado con éxito"
                : alertType === "duplicate"
                ? "⚠️ Certificado ya existente"
                : "❌ Ocurrió un problema"}
            </AlertDialogTitle>
            <AlertDialogDescription className="break-words space-y-2">
              {alertType === "success" && (
                <>
                  {cid && <div>CID generado en IPFS: {cid}</div>}
                  {txId && (
                    <div>
                      TxID: <span className="font-mono">{txId}</span>
                    </div>
                  )}
                  {typeof round === "number" && (
                    <div>
                      Round confirmado: <span className="font-mono">{round}</span>
                    </div>
                  )}
                </>
              )}
              {alertType === "duplicate" && <>Este PDF ya fue registrado previamente (hash duplicado).</>}
              {alertType === "error" && <>No se pudo completar el proceso. Revisa consola para más detalles.</>}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <Button onClick={() => setAlertType(null)}>
              <X className="w-4 h-4" /> Cerrar
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
