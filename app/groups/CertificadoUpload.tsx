'use client'

import { useState } from 'react'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Card, CardHeader, CardTitle, CardDescription, CardFooter, CardContent } from '@/components/ui/card'
import { AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogTitle, AlertDialogDescription, AlertDialogFooter } from '@/components/ui/alert-dialog'

import { Upload } from 'lucide-react'
import { X } from 'lucide-react'

export default function CertificadoUpload({ wallet }: { wallet: string }) {
  const [file, setFile] = useState<File | null>(null)
  const [hash, setHash] = useState<string | null>(null)
  const [alertType, setAlertType] = useState<null | 'success' | 'duplicate'>(null)
  const [cid, setCid] = useState<string>('')


  const calcularHash = async (file: File) => {
    const buffer = await file.arrayBuffer()
    const hashBuffer = await crypto.subtle.digest('SHA-256', buffer)
    const hashArray = Array.from(new Uint8Array(hashBuffer))
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('')
  }

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]
    if (!f) return
    if (f.type !== 'application/pdf') {
      alert('Solo se permiten archivos PDF')
      return
    }
    setFile(f)
    const h = await calcularHash(f)
    setHash(h)
  }

const handleSubmit = async () => {
  if (!file || !wallet || !hash) return

  const formData = new FormData()
  formData.append('file', file)
  formData.append('wallet', wallet)
  formData.append('hash', hash)

  try {
    const res = await fetch('http://localhost:4000/subir-certificado', {
      method: 'POST',
      body: formData
    })

    if (res.status === 409) {
  setAlertType(null) // Forzamos el reset para que se vuelva a abrir aunque sea el mismo tipo
  setTimeout(() => setAlertType('duplicate'), 10) // ⚠️ Delay mínimo para que React lo detecte
  return
}


    if (!res.ok) throw new Error('Error al subir')

    const data = await res.json()
    setCid(data.cid)
    setAlertType('success') // 👈 Esto activa el modal de éxito
  } catch (err) {
    console.error('❌ Error al subir:', err)
    alert('Error al subir certificado')
  }
}

  return (
    <>
      <Card className="max-w-xl mx-auto mt-6">
        <CardHeader>
          <CardTitle>Subir Certificado</CardTitle>
          <CardDescription>Sube un archivo PDF firmado para registrar en IPFS.</CardDescription>
        </CardHeader>
        <CardContent>
          <Input type="file" accept="application/pdf" onChange={handleFileChange} />
          {hash && <p className="text-sm mt-2 break-words text-muted-foreground">Hash SHA-256: {hash}</p>}
        </CardContent>
         <CardFooter className="flex justify-end">
            <Button onClick={handleSubmit} disabled={!file}>
                <Upload className="w-4 h-4" />
                Subir Certificado
            </Button>
        </CardFooter>
      </Card>

      <AlertDialog open={!!alertType} onOpenChange={() => setAlertType(null)}>
  <AlertDialogContent>
    <AlertDialogHeader>
      <AlertDialogTitle>
        {alertType === 'success'
          ? '✅ Certificado registrado con éxito'
          : '⚠️ Certificado ya existente'}
      </AlertDialogTitle>
      <AlertDialogDescription className="break-words">
        {alertType === 'success'
          ? `CID generado en IPFS:\n${cid}`
          : 'Este archivo PDF ya fue registrado previamente en el sistema.'}
      </AlertDialogDescription>
    </AlertDialogHeader>
    <AlertDialogFooter>
      <Button onClick={() => setAlertType(null)}> <X className="w-4 h-4" /> Cerrar</Button>
    </AlertDialogFooter>
  </AlertDialogContent>
</AlertDialog>

    </>
  )
}
