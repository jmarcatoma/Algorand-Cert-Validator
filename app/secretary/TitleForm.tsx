'use client';

import { useState } from 'react'
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { toast } from 'sonner'
import { PDFDocument, rgb, StandardFonts } from 'pdf-lib'
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter
} from '@/components/ui/alert-dialog'

import { Upload, X, Eye, Link as LinkIcon, Download } from 'lucide-react'

const facultades = {
  "Facultad de Administración de Empresas": [
    { nombre: "Administración de Empresas", titulo: "Licenciado/a en Administración de Empresas" },
    { nombre: "Finanzas", titulo: "Licenciado/a en Finanzas" },
    { nombre: "Mercadotecnia", titulo: "Licenciado/a en Mercadotecnia" },
    { nombre: "Contabilidad y Auditoría", titulo: "Licenciado/a en Contabilidad y Auditoría" },
    { nombre: "Gestión del Transporte", titulo: "Licenciado/a en Gestión del Transporte" }
  ],
  "Facultad de Ciencias": [
    { nombre: "Ingeniería Química", titulo: "Ingeniero/a Químico/a" },
    { nombre: "Química", titulo: "Químico/a" },
    { nombre: "Ingeniería Ambiental", titulo: "Ingeniero/a Ambiental" },
    { nombre: "Bioquímica y Farmacia", titulo: "Bioquímico/a Farmacéutico/a" },
    { nombre: "Estadística", titulo: "Ingeniero/a Estadística" },
    { nombre: "Matemática", titulo: "Matemático/a" },
    { nombre: "Física", titulo: "Físico/a" }
  ],
  "Facultad de Ciencias Pecuarias": [
    { nombre: "Zootecnia", titulo: "Ingeniero/a en Zootecnia" },
    { nombre: "Agroindustria", titulo: "Ingeniero/a en Agroindustria" },
    { nombre: "Veterinaria", titulo: "Médico Veterinario" }
  ],
  "Facultad de Informática y Electrónica": [
    { nombre: "Diseño Gráfico", titulo: "Licenciado/a en Diseño Gráfico" },
    { nombre: "Electrónica y Automatización", titulo: "Ingeniero/a en Electrónica y Automatización" },
    { nombre: "Telecomunicaciones", titulo: "Ingeniero/a en Telecomunicaciones" },
    { nombre: "Software", titulo: "Ingeniero/a de Software" },
    { nombre: "Tecnologías de la Información", titulo: "Ingeniero/a en Tecnologías de la Información" },
    { nombre: "Telemática", titulo: "Ingeniero/a en Telemática" },
    { nombre: "Electricidad", titulo: "Ingeniero/a en Electricidad" }
  ],
  "Facultad de Mecánica": [
    { nombre: "Mecánica", titulo: "Ingeniero/a en Mecánica" },
    { nombre: "Ingeniería Industrial", titulo: "Ingeniero/a Industrial" },
    { nombre: "Mantenimiento Industrial", titulo: "Ingeniero/a en Mantenimiento Industrial" },
    { nombre: "Ingeniería Automotriz", titulo: "Ingeniero/a Automotriz" }
  ],
  "Facultad de Recursos Naturales": [
    { nombre: "Agronomía", titulo: "Ingeniero/a en Agronomía" },
    { nombre: "Forestal", titulo: "Ingeniero/a Forestal" },
    { nombre: "Turismo", titulo: "Licenciado/a en Turismo" },
    { nombre: "Recursos Naturales Renovables", titulo: "Ingeniero/a en Recursos Naturales Renovables" }
  ],
  "Facultad de Salud Pública": [
    { nombre: "Promoción de la Salud", titulo: "Licenciado/a en Promoción de la Salud" },
    { nombre: "Medicina", titulo: "Médico/a" },
    { nombre: "Nutrición y Dietética", titulo: "Licenciado/a en Nutrición y Dietética" },
    { nombre: "Gastronomía", titulo: "Licenciado/a en Gastronomía" }
  ]
}

export default function TitleForm({ wallet }: { wallet: string | null }) {
  const [nombre, setNombre] = useState('')
  const [facultad, setFacultad] = useState('')
  const [carrera, setCarrera] = useState('')
  const [codigo, setCodigo] = useState('')
  const [numero, setNumero] = useState('')
  const [refrendado, setRefrendado] = useState('')
  const [fecha, setFecha] = useState('')

  const [showSuccess, setShowSuccess] = useState(false)
  const [cidGenerado, setCidGenerado] = useState('')
  const [hashHexGenerado, setHashHexGenerado] = useState<string>('')
  const [anchoring, setAnchoring] = useState(false)
  const [txId, setTxId] = useState<string>('')
  const [round, setRound] = useState<number | null>(null)

  const generarPDF = async () => {
    const existingPdfBytes = await fetch('/titulo_base_final.pdf').then(res => res.arrayBuffer())
    const pdfDoc = await PDFDocument.load(existingPdfBytes)
    const font = await pdfDoc.embedFont(StandardFonts.TimesRoman)
    const fontBold = await pdfDoc.embedFont(StandardFonts.TimesRomanBoldItalic)
    const page = pdfDoc.getPages()[0]
    const { width } = page.getSize()

    const drawCentered = (text: string, y: number, size = 12) => {
      const textWidth = fontBold.widthOfTextAtSize(text, size)
      page.drawText(text, {
        x: (width - textWidth) / 2,
        y,
        size,
        font: fontBold,
        color: rgb(0, 0, 0)
      })
    }

    drawCentered(facultad.replace('Facultad de ', ''), 551, 30)
    const tituloFinal = (facultades as any)[facultad]?.find((c: any) => c.nombre === carrera)?.titulo || carrera
    drawCentered(tituloFinal, 470, 30)
    drawCentered(nombre, 395, 30)

    page.drawText(
      `${new Date(fecha).toLocaleDateString('es-EC', { day: '2-digit', month: 'long', year: 'numeric' })}`,
      { x: 477, y: 252, size: 11, font, color: rgb(0, 0, 0) }
    )

    page.drawText(` ${refrendado}`, { x: 125, y: 80, size: 11, font: fontBold, color: rgb(0, 0, 0) })
    page.drawText(` ${codigo}`, { x: width - 97, y: 80, size: 11, font: fontBold, color: rgb(0, 0, 0) })

    return await pdfDoc.save()
  }

  const vistaPrevia = async () => {
    try {
      const pdfBytes = await generarPDF()
      const blob = new Blob([pdfBytes], { type: 'application/pdf' })
      const url = URL.createObjectURL(blob)
      window.open(url, '_blank')
    } catch {
      toast.error('Error al generar vista previa')
    }
  }

  // ✅ MOVER AQUÍ (fuera de subirTitulo): descargar original desde backend
  const descargarOriginal = async () => {
    try {
      const h = hashHexGenerado?.trim()
      if (!h) return toast.error('Aún no hay hash para descargar')
      const url = `http://localhost:4000/api/certificados/${h}/download`
      window.open(url, '_blank')
    } catch {
      toast.error('No se pudo iniciar la descarga')
    }
  }

  const subirTitulo = async () => {
    if (!wallet || !nombre || !facultad || !carrera || !codigo || !numero || !refrendado || !fecha) {
      return toast.error('Completa todos los campos')
    }

    setTxId('')
    setRound(null)
    setCidGenerado('')
    setHashHexGenerado('')

    try {
      const pdfBytes = await generarPDF()

      // hash SHA-256 del PDF
      const hashBuffer = await crypto.subtle.digest('SHA-256', pdfBytes)
      const hashArray = Array.from(new Uint8Array(hashBuffer))
      const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('')
      setHashHexGenerado(hashHex)

      // 1) Guardar en backend (IPFS + BD)
      const formData = new FormData()
      formData.append('file', new Blob([pdfBytes], { type: 'application/pdf' }), `${nombre}_titulo.pdf`)
      formData.append('wallet', wallet)
      formData.append('hash', hashHex)

      const res = await fetch('http://localhost:4000/guardar-titulo', { method: 'POST', body: formData })
      if (res.status === 409) {
        toast.error('Este título ya existe (hash duplicado)')
        return
      }
      if (!res.ok) {
        const e = await res.text().catch(() => '')
        throw new Error(e || 'Error al subir el título')
      }

            // ... tras subir a IPFS:
      const data = await res.json();
      setCidGenerado(data.cid ?? '');
      setShowSuccess(true);
      toast.success('Título guardado (IPFS + BD)'); // si luego quitas BD, deja el texto en "IPFS"

      // 2) Anclar en Algorand (note con hash+cid+wallet)
      try {
        setAnchoring(true);
        const anchorRes = await fetch('http://localhost:4000/api/algod/anchorNote', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            to: wallet,
            hashHex,
            cid: data.cid,                         // importante
            filename: `${nombre}_titulo.pdf`,      // opcional
          }),
        });
        const ajson = await anchorRes.json().catch(() => ({}));
        if (anchorRes.ok && ajson.txId) {
          setTxId(ajson.txId);
          setRound(ajson.round ?? null);
          toast.success('Transacción enviada a Algorand');
        } else {
          toast.error(ajson?.error || 'No se pudo anclar en Algorand');
        }
      } catch (err) {
        console.error('anchor error', err);
        toast.error('Error de red al anclar en Algorand');
      } finally {
        setAnchoring(false);
      }

    } catch (err) {
      console.error(err)
      toast.error('Error al subir el título')
    }
  }

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>Nuevo Título Académico</CardTitle>
          <CardDescription>Completa los campos antes de generar el PDF.</CardDescription>
        </CardHeader>

        <CardContent className="grid gap-4">
          <Input placeholder="Nombre del Estudiante" value={nombre} onChange={e => setNombre(e.target.value)} />
          <Select value={facultad} onValueChange={setFacultad}>
            <SelectTrigger><SelectValue placeholder="Seleccione una facultad" /></SelectTrigger>
            <SelectContent>
              {Object.keys(facultades).map(f => (
                <SelectItem key={f} value={f}>{f}</SelectItem>
              ))}
            </SelectContent>
          </Select>

          {facultad && (
            <Select value={carrera} onValueChange={setCarrera}>
              <SelectTrigger><SelectValue placeholder="Seleccione una carrera" /></SelectTrigger>
              <SelectContent>
                {((facultades as any)[facultad] || []).map((c: any, idx: number) => (
                  <SelectItem key={`${facultad}-${idx}`} value={c.nombre}>{c.nombre}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}

          <Input placeholder="Código de Matrícula" value={codigo} onChange={e => setCodigo(e.target.value)} />
          <Input placeholder="Número de Título" value={numero} onChange={e => setNumero(e.target.value)} type="number" />
          <Input placeholder="Refrendado" value={refrendado} onChange={e => setRefrendado(e.target.value)} type="number" />
          <Input type="date" value={fecha} onChange={e => setFecha(e.target.value)} />

          {/* Info post-acción */}
          {hashHexGenerado && (
            <div className="text-sm text-muted-foreground break-words">
              <div><span className="font-semibold">Hash (SHA-256):</span> <span className="font-mono">{hashHexGenerado}</span></div>
            </div>
          )}

          {(txId || round) && (
            <div className="text-sm break-words space-y-1">
              {txId && (
                <>
                  <div className="font-semibold">Transacción (Algorand):</div>
                  <div className="font-mono">{txId}</div>
                </>
              )}
              {typeof round === 'number' && (
                <div>Round confirmado: <span className="font-mono">{round}</span></div>
              )}
              <div className="flex flex-wrap items-center gap-2 mt-1">
                {/* 🚀 NUEVO BOTÓN: Descargar PDF */}
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={descargarOriginal}
                  disabled={!hashHexGenerado}
                  className="inline-flex items-center gap-2"
                >
                  <Download className="w-4 h-4" /> Descargar PDF (IPFS/Backend)
                </Button>
              </div>
            </div>
          )}
        </CardContent>

        <CardFooter className="flex justify-end gap-4">
          <Button variant="outline" onClick={vistaPrevia}>
            <Eye className="w-4 h-4" />&nbsp;Vista Previa
          </Button>
          <Button onClick={subirTitulo} disabled={anchoring}>
            <Upload className="w-4 h-4" />&nbsp;{anchoring ? 'Anclando…' : 'Subir Título'}
          </Button>
        </CardFooter>

        <AlertDialog open={showSuccess} onOpenChange={setShowSuccess}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>✅ Título subido con éxito</AlertDialogTitle>
              <AlertDialogDescription className="break-words space-y-3">
                {cidGenerado && (
                  <div className="mt-2">
                    <a
                      href={`https://ipfs.io/ipfs/${cidGenerado}`}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-2 text-blue-600 underline"
                    >
                      Descargar desde IPFS
                    </a>
                  </div>
                )}

                {txId ? (
                  <div className="space-y-2">
                    <div>Se envió la transacción de anclado:</div>
                    <div className="font-mono">{txId}</div>
                    <div className="flex flex-wrap items-center gap-2">
                      <Button
                        type="button"
                        variant="secondary"
                        size="sm"
                        onClick={descargarOriginal}
                        disabled={!hashHexGenerado}
                        className="inline-flex items-center gap-2"
                      >
                        <Download className="w-4 h-4" /> Descargar PDF (IPFS/Backend)
                      </Button>
                    </div>
                    {typeof round === 'number' && (
                      <div>Round confirmado: <span className="font-mono">{round}</span></div>
                    )}
                  </div>
                ) : (
                  <>Enviando transacción de anclado…</>
                )}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <Button onClick={() => setShowSuccess(false)}>
                <X className="w-4 h-4" /> Cerrar
              </Button>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </Card>
    </>
  )
}
