'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { PeraWalletConnect } from '@perawallet/connect'
import HistorialCertificados from "@/app/admin/HistorialCertificados";

import { LogOut } from 'lucide-react'
import { Trash2 } from 'lucide-react'
import { UserPlus } from 'lucide-react'
import { Wallet } from 'lucide-react'




const ADMIN_WALLET = "WF7545X4CNPWV2XUIJ6VSA47Q37WEYVLZCZCEGO72DDNK2RZEVMNBXV2IE";
const ADMIN_IP = "190.57.184.130";
//const ADMIN_IP = "45.184.102.100";//


const peraWallet = new PeraWalletConnect()

export default function AdminPanel() {
  const [wallet, setWallet] = useState<string | null>(null)
  const [ip, setIp] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [direccion, setDireccion] = useState('')
  const [rol, setRol] = useState('Secretaria')
  const [rolesGuardados, setRolesGuardados] = useState<Record<string, string>>({})
  const router = useRouter()

  const ROLES = ['Admin', 'Secretaria', 'Grupo-APS', 'Grupo-CS', 'Grupo-COMSOC', 'Grupo-Radio']

  useEffect(() => {
  const verificarAcceso = async () => {
    try {
      const cuentas = await peraWallet.reconnectSession()
      const storedWallet = cuentas[0] || localStorage.getItem('walletAddress')
      if (storedWallet) {
        setWallet(storedWallet)
      }

      // ⚠️ Usa tu endpoint backend, no api externa
      const res = await fetch('https://api.ipify.org?format=json')
      const data = await res.json()
      setIp(data.ip)


      await obtenerRolesDesdeBD()
    } catch (error) {
      console.error('❌ Error durante verificación:', error)
    } finally {
      setLoading(false)
    }
  }

  verificarAcceso()
}, [])


  const conectarWallet = async () => {
    try {
      const accounts = await peraWallet.connect()
      if (accounts.length > 0) {
        setWallet(accounts[0])
        localStorage.setItem('walletAddress', accounts[0])
      }
    } catch (error) {
      console.error('Error al conectar con PeraWallet', error)
    }
  }

  const desconectarWallet = async () => {
    await peraWallet.disconnect()
    localStorage.removeItem('walletAddress')
    setWallet(null)
    router.push('/')
  }

  const guardarRol = async () => {
  if (!direccion.trim()) {
    alert('⚠️ Ingresa una dirección de wallet.')
    return
  }

  try {
    const response = await fetch('http://localhost:4000/guardar-rol', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        wallet: direccion,
        role: rol,
      }),
    })

    const contentType = response.headers.get('content-type')
    const text = await response.text()

    if (!response.ok) {
      console.error('❌ Error:', text)
      throw new Error('Falló la respuesta del servidor')
    }

    if (!contentType?.includes('application/json')) {
      console.warn('⚠️ El servidor no devolvió JSON. Respuesta:', text)
      return
    }

    const data = JSON.parse(text)
    console.log('✅ Backend respondió:', data)

    await obtenerRolesDesdeBD()
    setDireccion('')
    alert('✅ Rol asignado correctamente')
  } catch (err) {
    console.error('❌ Error inesperado:', err)
    alert('❌ No se pudo asignar el rol. Revisa consola.')
  }
}


  const obtenerRolesDesdeBD = async () => {
    try {
      const res = await fetch('http://localhost:4000/listar-roles')
      const data = await res.json()
      setRolesGuardados(data)
    } catch (err) {
      console.error(err)
    }
  }

  const eliminarRol = async (wallet: string) => {
    try {
      const res = await fetch(`http://localhost:4000/eliminar-rol/${wallet}`, {
        method: 'DELETE'
      })
      if (res.ok) {
        await obtenerRolesDesdeBD()
      } else {
        throw new Error('Error al eliminar rol')
      }
    } catch (err) {
      console.error('❌ Error al eliminar rol:', err)
    }
  }

  const accesoPermitido = wallet === ADMIN_WALLET && ip === ADMIN_IP


  if (loading) return <p className="text-center mt-10 text-lg">Verificando acceso...</p>

  if (!wallet || !ip) {
    return (
      <div className="flex flex-col items-center justify-center h-screen text-center px-3">
        <p className="mb-2">Conecta tu wallet para acceder al panel de administrador</p>
        <Button
          onClick={conectarWallet}
          className="bg-green-700 text-white flex items-center gap-2"
        >
          <Wallet className="w-5 h-5" />
          Conectar Wallet
        </Button>
      </div>

    )
  }

  if (!accesoPermitido) {
    return (
      <div className="text-center mt-10 text-red-700">
        <p className="text-lg font-semibold">🚫 Acceso denegado</p>
        <p>Tu wallet o IP no están autorizadas para esta sección.</p>
        <button onClick={desconectarWallet} className="mt-4 bg-gray-500 text-white px-4 py-2 rounded">
          Desconectar
        </button>
      </div>
    )
  }

  return (
    <div className="container mx-auto px-4 py-12">
      <h1 className="text-3xl font-bold mb-8 text-black">Panel de Administración</h1>

      <div className="flex justify-between items-center mb-6">
        <p className="text-sm text-muted-foreground">
          👛 {wallet?.slice(0, 6)}...{wallet?.slice(-4)} — IP: {ip}
        </p>
        <Button variant="destructive" size="sm" onClick={desconectarWallet}> <LogOut className="w-4 h-4 mr-2" />
          Cerrar sesión
        </Button>
      </div>

      <Tabs defaultValue="roles">
        <TabsList className="mb-8">
          <TabsTrigger value="roles">Gestión de Usuarios</TabsTrigger>
          <TabsTrigger value="historial">Historial de Certificados</TabsTrigger>
        </TabsList>

        <TabsContent value="roles">
          <Card>
            <CardHeader>
              <CardTitle>👥 Gestión de Roles</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="flex flex-col sm:flex-row gap-4 mb-6">
                <Input
                  placeholder="Dirección de wallet"
                  value={direccion}
                  onChange={(e) => setDireccion(e.target.value)}
                />
                <Select value={rol} onValueChange={(value) => setRol(value)}>
                  <SelectTrigger className="w-[180px]">
                    <SelectValue placeholder="Rol" />
                  </SelectTrigger>
                  <SelectContent>
                    {ROLES.map((r) => (
                      <SelectItem key={r} value={r}>{r}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button onClick={guardarRol}>
                  <UserPlus className="w-4 h-4 mr-2" />
                  Asignar Rol</Button>
              </div>

              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Wallet</TableHead>
                    <TableHead>Rol</TableHead>
                    <TableHead>Acciones</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {Object.entries(rolesGuardados).map(([dir, r]) => (
                    <TableRow key={dir}>
                      <TableCell>{dir}</TableCell>
                      <TableCell>{r}</TableCell>
                      <TableCell>
                        <Button variant="destructive" size="sm" onClick={() => eliminarRol(dir)} className="flex items-center gap-2"> 
                          <Trash2 className="w-4 h-4" />
                          Eliminar
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="historial">
          <Card>
            <CardHeader>
              <CardTitle>📄 Historial de Certificados</CardTitle>
            </CardHeader>
            <CardContent>
              <HistorialCertificados />
            </CardContent>
          </Card>
        </TabsContent>

      </Tabs>
    </div>
  )
}
