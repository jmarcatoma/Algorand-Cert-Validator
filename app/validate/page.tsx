"use client"

import type React from "react"

import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { AlertCircle, CheckCircle2, Upload } from "lucide-react"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"

export default function ValidatePage() {
  const [file, setFile] = useState<File | null>(null)
  const [validationResult, setValidationResult] = useState<{
    valid: boolean
    message: string
    details?: {
      title: string
      issuedTo: string
      issuedBy: string
      date: string
      txId: string
    }
  } | null>(null)

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      setFile(e.target.files[0])
      setValidationResult(null)
    }
  }

  const validateCertificate = async () => {
    // Simulación de validación - en producción, esto se conectaría a Algorand
    setTimeout(() => {
      // Simulamos una validación exitosa
      setValidationResult({
        valid: true,
        message: "El certificado es auténtico y ha sido verificado en la blockchain de Algorand.",
        details: {
          title: "Certificado de Finalización",
          issuedTo: "Juan Pérez",
          issuedBy: "Universidad Tecnológica",
          date: "15/04/2023",
          txId: "UXVS5QBCKNQCNWVTMCJVNBSQCNVMCNVMCNVMCNVMCNVMCNVMCNVMCNVM",
        },
      })
    }, 1500)
  }

  return (
    <div className="container mx-auto px-4 py-12">
      <div className="max-w-3xl mx-auto">
        <h1 className="text-3xl font-bold mb-8 text-center">Validación de Certificados</h1>

        <Card className="mb-8">
          <CardHeader>
            <CardTitle>Sube tu certificado para validar</CardTitle>
            <CardDescription>
              Sube el archivo PDF del certificado para verificar su autenticidad en la blockchain de Algorand.
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
            <Button className="w-full" onClick={validateCertificate} disabled={!file}>
              <Upload className="mr-2 h-4 w-4" /> Validar Certificado
            </Button>
          </CardFooter>
        </Card>

        {validationResult && (
          <Alert variant={validationResult.valid ? "default" : "destructive"}>
            {validationResult.valid ? <CheckCircle2 className="h-4 w-4" /> : <AlertCircle className="h-4 w-4" />}
            <AlertTitle>{validationResult.valid ? "Certificado Válido" : "Certificado Inválido"}</AlertTitle>
            <AlertDescription>{validationResult.message}</AlertDescription>
          </Alert>
        )}

        {validationResult && validationResult.valid && validationResult.details && (
          <Card className="mt-8">
            <CardHeader>
              <CardTitle>Detalles del Certificado</CardTitle>
              <CardDescription>Información verificada en la blockchain</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="space-y-4">
                <div className="grid grid-cols-3 gap-4">
                  <div className="space-y-1">
                    <p className="text-sm font-medium leading-none">Título</p>
                    <p className="text-sm text-muted-foreground">{validationResult.details.title}</p>
                  </div>
                  <div className="space-y-1">
                    <p className="text-sm font-medium leading-none">Emitido a</p>
                    <p className="text-sm text-muted-foreground">{validationResult.details.issuedTo}</p>
                  </div>
                  <div className="space-y-1">
                    <p className="text-sm font-medium leading-none">Fecha de emisión</p>
                    <p className="text-sm text-muted-foreground">{validationResult.details.date}</p>
                  </div>
                </div>
                <div className="space-y-1">
                  <p className="text-sm font-medium leading-none">Emitido por</p>
                  <p className="text-sm text-muted-foreground">{validationResult.details.issuedBy}</p>
                </div>
                <div className="space-y-1">
                  <p className="text-sm font-medium leading-none">ID de Transacción en Algorand</p>
                  <p className="text-sm text-muted-foreground break-all">{validationResult.details.txId}</p>
                </div>
              </div>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  )
}
