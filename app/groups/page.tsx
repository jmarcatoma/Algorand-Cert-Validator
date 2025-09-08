'use client'

import { useEffect, useState } from 'react'
import { PeraWalletConnect } from '@perawallet/connect'
import { Button } from '@/components/ui/button'
import { Card, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import CertificadoUpload from './CertificadoUpload'

import { LogOut } from 'lucide-react'
import { Wallet } from 'lucide-react'


const allowedRoles = ['Grupo-APS', 'Grupo-CS', 'Grupo-COMSOC', 'Grupo-Radio']
const peraWallet = new PeraWalletConnect()

export default function GruposPage() {
  const [wallet, setWallet] = useState<string | null>(null)
  const [role, setRole] = useState<string | null>(null)

  const connectWallet = async () => {
    try {
      const accounts = await peraWallet.connect()
      setWallet(accounts[0])
      localStorage.setItem('walletAddress', accounts[0])
    } catch (error) {
      console.warn('Conexión cancelada o fallida')
    }
  }

  const getRoleFromBackend = async (address: string) => {
    try {
      const res = await fetch(`http://localhost:4000/roles/${address}`)
      if (!res.ok) throw new Error('No autorizado')
      const data = await res.json()
      setRole(data.role)
    } catch (err) {
      console.error('❌ Error al obtener el rol:', err)
      setRole(null)
    }
  }

  useEffect(() => {
    const reconnect = async () => {
      const accounts = await peraWallet.reconnectSession()
      const storedWallet = accounts[0] || localStorage.getItem('walletAddress')
      if (storedWallet) {
        setWallet(storedWallet)
      }
    }
    reconnect()
  }, [])

  useEffect(() => {
    if (wallet) getRoleFromBackend(wallet)
  }, [wallet])

  if (!wallet)
    return (
      <div className="flex items-center justify-center h-screen">
        <Card className="w-[350px]">
          <CardHeader>
            <CardTitle>Grupos</CardTitle>
            <CardDescription>Conecta tu wallet para continuar.</CardDescription>
          </CardHeader>
          <CardFooter>
            <Button onClick={connectWallet}><Wallet className="w-5 h-5" /> Conectar Wallet</Button>
          </CardFooter>
        </Card>
      </div>
    )

  if (!allowedRoles.includes(role || ''))
    return (
      <div className="flex items-center justify-center h-screen text-center px-4">
        <Card className="w-[400px] py-6 px-4 flex flex-col items-center justify-between gap-4">
          <div>
            <h2 className="text-xl font-bold mb-2">Acceso Restringido</h2>
            <p className="text-sm text-muted-foreground">
              Este módulo solo está disponible para los roles de grupo autorizados.
            </p>
          </div>
          <Button
            onClick={async () => {
              await peraWallet.disconnect()
              localStorage.removeItem('walletAddress')
              setWallet(null)
              setRole(null)
            }}
          > <Wallet className="w-5 h-5" />
            Cambiar Wallet
          </Button>
        </Card>
      </div>
    )

  return (
    <div className="max-w-4xl mx-auto py-10">
      <div className="flex justify-between mb-4">
        <p className="text-muted-foreground text-sm">Rol: <strong>{role}</strong></p>
        <Button variant="destructive" size="sm" onClick={async () => {
          await peraWallet.disconnect()
          localStorage.removeItem('walletAddress')
          setWallet(null)
          setRole(null)
        }}><LogOut className="w-4 h-4 mr-2" /> Cerrar sesión</Button>
      </div>

      <CertificadoUpload wallet={wallet} />
    </div>
  )
}
