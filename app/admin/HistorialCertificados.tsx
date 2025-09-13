'use client'

import { useEffect, useState } from 'react'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Button } from '@/components/ui/button'
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter
} from '@/components/ui/alert-dialog'

import { Trash2 } from 'lucide-react'



type Certificado = {
  id: number
  wallet: string
  nombre_archivo: string
  hash: string
  cid: string
  fecha: string
}

export default function HistorialCertificados() {
  const [certificados, setCertificados] = useState<Certificado[]>([])
  const [idAEliminar, setIdAEliminar] = useState<number | null>(null)

  useEffect(() => {
    const fetchData = async () => {
      try {
        const res = await fetch('http://localhost:4000/certificados')
        const data = await res.json()
        setCertificados(data)
      } catch (err) {
        console.error('❌ Error al cargar certificados:', err)
      }
    }

    fetchData()
  }, [])

  const eliminarCertificado = async () => {
    if (!idAEliminar) return
    try {
      const res = await fetch(`http://localhost:4000/eliminar-certificado/${idAEliminar}`, {
        method: 'DELETE'
      })
      if (res.ok) {
        setCertificados(prev => prev.filter(c => c.id !== idAEliminar))
      } else {
        console.error('❌ No se pudo eliminar')
      }
    } catch (err) {
      console.error('❌ Error al eliminar certificado:', err)
    } finally {
      setIdAEliminar(null)
    }
  }

  const extraerDatos = (nombre: string) => {
    const tipo = nombre.toLowerCase().includes('titulo') ? 'Título' : 'Certificado'
    const partes = nombre.replace('.pdf', '').split('_')
    return {
      tipo,
      titulo: partes[1] || '—',
      destinatario: partes[0] || '—'
    }
  }

  if (certificados.length === 0) {
    return <p className="text-muted-foreground">No hay certificados registrados aún.</p>
  }

  return (
    <>
      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Tipo</TableHead>
              <TableHead>Título</TableHead>
              <TableHead>Destinatario</TableHead>
              <TableHead>Emisor</TableHead>
              <TableHead>Fecha</TableHead>
              <TableHead>Hash</TableHead>
              <TableHead>Acciones</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {certificados.map(cert => {
              const { tipo, titulo, destinatario } = extraerDatos(cert.nombre_archivo)
              return (
                <TableRow key={cert.id}>
                  <TableCell>{tipo}</TableCell>
                  <TableCell>{titulo}</TableCell>
                  <TableCell>{destinatario}</TableCell>
                  <TableCell className="text-xs font-mono truncate max-w-[180px]">{cert.wallet}</TableCell>
                  <TableCell>{cert.fecha.split('T')[0]}</TableCell>
                  <TableCell>
                    <a
                      href={`https://check.ipfs.network/?cid=${cert.cid}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-xs underline font-mono text-blue-600"
                    >
                      {cert.hash.slice(0, 12)}...
                    </a>

                  </TableCell>
                  <TableCell>
                    <Button variant="destructive" size="sm" onClick={() => setIdAEliminar(cert.id)} className="flex items-center gap-2">
                      <Trash2 className="w-4 h-4" />
                      Eliminar
                    </Button>
                  </TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
      </div>

      <AlertDialog open={idAEliminar !== null} onOpenChange={() => setIdAEliminar(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>¿Eliminar certificado?</AlertDialogTitle>
            <AlertDialogDescription>
              Esta acción no se puede deshacer. El certificado será eliminado del historial.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <Button variant="outline" onClick={() => setIdAEliminar(null)}>Cancelar</Button>
            <Button variant="destructive" onClick={eliminarCertificado} className="flex items-center gap-2">
              <Trash2 className="w-4 h-4" />Eliminar</Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
