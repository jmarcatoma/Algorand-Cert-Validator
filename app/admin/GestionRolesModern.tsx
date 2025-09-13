"use client";

import { useEffect, useState } from "react";
import { PeraWalletConnect } from "@perawallet/connect";

const peraWallet = new PeraWalletConnect();

const ROLES = [
  "Admin",
  "Secretaria",
  "Grupo-APS",
  "Grupo-CS",
  "Grupo-COMSOC",
  "Grupo-Radio"
];

export default function GestionRolesModern() {
  const [direccion, setDireccion] = useState("");
  const [rol, setRol] = useState("Secretaria");
  const [rolesGuardados, setRolesGuardados] = useState<Record<string, string>>({});
  const [adminWallet, setAdminWallet] = useState<string | null>(null);
  const [adminRol, setAdminRol] = useState<string | null>(null);

  useEffect(() => {
    const guardados = JSON.parse(localStorage.getItem("rolesWallet") || "{}");
    setRolesGuardados(guardados);

    peraWallet.reconnectSession().then((accounts) => {
      const wallet = accounts[0];
      if (wallet) {
        setAdminWallet(wallet);
        const rolDetectado = guardados[wallet] || "invitado";
        setAdminRol(rolDetectado);
      }
    });
  }, []);

  const guardarRol = () => {
    if (!direccion.trim()) return alert("⚠️ Ingresa una dirección de wallet.");

    const actualizados = { ...rolesGuardados, [direccion]: rol };
    localStorage.setItem("rolesWallet", JSON.stringify(actualizados));
    setRolesGuardados(actualizados);
    setDireccion("");
    alert("✅ Rol asignado correctamente.");
  };

  const eliminarRol = (dir: string) => {
    const copia = { ...rolesGuardados };
    delete copia[dir];
    localStorage.setItem("rolesWallet", JSON.stringify(copia));
    setRolesGuardados(copia);
  };

  return (
    <div className="bg-zinc-900 text-white p-6 rounded-lg shadow-md">
      <h2 className="text-2xl font-semibold mb-6">👥 Gestión de Roles</h2>

      {adminRol !== "Admin" && (
        <div className="text-red-400 mb-4">
          Solo el administrador puede gestionar los roles.
        </div>
      )}

      {adminRol === "Admin" && (
        <>
          <div className="flex flex-col sm:flex-row gap-4 mb-4">
            <input
              type="text"
              placeholder="Dirección de wallet"
              value={direccion}
              onChange={(e) => setDireccion(e.target.value)}
              className="flex-1 p-2 bg-zinc-800 text-white border border-zinc-700 rounded"
            />
            <select
              value={rol}
              onChange={(e) => setRol(e.target.value)}
              className="p-2 bg-zinc-800 text-white border border-zinc-700 rounded"
            >
              {ROLES.map((r) => (
                <option key={r} value={r}>{r}</option>
              ))}
            </select>
            <button
              onClick={guardarRol}
              className="bg-green-600 hover:bg-green-700 text-white px-4 py-2 rounded"
            >
              Asignar Rol
            </button>
          </div>

          <div className="mt-6">
            <h3 className="text-lg font-semibold mb-2">📋 Roles asignados</h3>
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="bg-zinc-800">
                  <th className="p-2 border border-zinc-700">Wallet</th>
                  <th className="p-2 border border-zinc-700">Rol</th>
                  <th className="p-2 border border-zinc-700">Acción</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(rolesGuardados).map(([dir, r]) => (
                  <tr key={dir}>
                    <td className="p-2 border border-zinc-700">{dir}</td>
                    <td className="p-2 border border-zinc-700">{r}</td>
                    <td className="p-2 border border-zinc-700">
                      <button
                        onClick={() => eliminarRol(dir)}
                        className="bg-red-600 hover:bg-red-700 text-white px-3 py-1 rounded"
                      >
                        Eliminar
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
