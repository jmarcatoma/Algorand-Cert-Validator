"use client"

import { useContext } from "react"
import { Navigate } from "react-router-dom"
import { WalletContext } from "../contexts/WalletContext"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { AlertCircle } from "lucide-react"

const ProtectedRoute = ({ children, requiredRole }) => {
  const { connected, role } = useContext(WalletContext)

  if (!connected) {
    return <Navigate to="/" replace />
  }

  if (role !== requiredRole) {
    return (
      <div className="container mx-auto px-4 py-12 max-w-3xl">
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>Acceso denegado</AlertTitle>
          <AlertDescription>
            No tienes los permisos necesarios para acceder a esta página. Tu rol actual es: {role || "invitado"}.
          </AlertDescription>
        </Alert>
        <div className="mt-4 text-center">
          <Navigate to="/" replace />
        </div>
      </div>
    )
  }

  return children
}

export default ProtectedRoute
