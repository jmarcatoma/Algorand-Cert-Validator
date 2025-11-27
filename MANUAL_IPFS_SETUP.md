# 📘 Manual Completo: Configuración IPFS Cluster con Sync Automático

## 🎯 Objetivo

Configurar un cluster IPFS de 3 nodos con sincronización automática del índice de certificados usando IPNS y systemd.

---

## 📋 Información de Nodos

| Nodo | IP | Usuario | Rol |
|------|------------|---------|-----|
| 194  | 192.168.1.194 | jmarcatoma | Principal |
| 193  | 192.168.1.193 | nodo1 | Secundario |
| 192  | 192.168.1.192 | nodo3 | Terciario |

---

## Paso 1: Exportar IPNS Key del Nodo Principal

### En Nodo 194 (Principal)

```bash
ssh jmarcatoma@192.168.1.194

# 1. Verificar que la key existe
ipfs key list -l

# Deberías ver:
# k51qzi5uqu5dhonp113olftb52kmnb3vo9nvyc20910k7nk1pgurprtwp3b0sb algocert-index-key

# 2. Exportar la key
ipfs key export algocert-index-key

# Esto crea el archivo: algocert-index-key.key

# 3. Verificar el archivo
ls -lh algocert-index-key.key

# 4. Ver el ID de la key (anotarlo)
ipfs key list -l | grep algocert-index-key
```

**📝 Anotar el ID:** k51qzi5uqu5dhonp113olftb52kmnb3vo9nvyc20910k7nk1pgurprtwp3b0sb

---

## Paso 2: Copiar Key a Otros Nodos

### Desde Nodo 194

```bash
# Copiar a nodo 193
scp algocert-index-key.key nodo1@192.168.1.193:~/

# Copiar a nodo 192
scp algocert-index-key.key nodo3@192.168.1.192:~/

# Verificar permisos
ls -lh algocert-index-key.key
```

---

## Paso 3: Importar Key en Nodo 193

### SSH al Nodo 193

```bash
ssh nodo1@192.168.1.193

# 1. Verificar que el archivo llegó
ls -lh ~/algocert-index-key.key

# 2. Importar la key
ipfs key import algocert-index-key algocert-index-key.key

# Debería mostrar:
# imported key k51qzi5uqu5dhonp113olftb52kmnb3vo9nvyc20910k7nk1pgurprtwp3b0sb

# 3. Verificar importación
ipfs key list -l | grep algocert-index-key

# Debe mostrar el MISMO ID que nodo 194:
# k51qzi5uqu5dhonp113olftb52kmnb3vo9nvyc20910k7nk1pgurprtwp3b0sb algocert-index-key

# 4. Eliminar archivo de key (seguridad)
rm ~/algocert-index-key.key
```

---

## Paso 4: Importar Key en Nodo 192

### SSH al Nodo 192

```bash
ssh nodo3@192.168.1.192

# Repetir los mismos pasos del Paso 3
ipfs key import algocert-index-key algocert-index-key.key
ipfs key list -l | grep algocert-index-key
rm ~/algocert-index-key.key
```

---

## Paso 5: Verificar IPNS en Todos los Nodos

### Verificación Completa

```bash
# EN CADA NODO (194, 193, 192), ejecutar:

# 1. Obtener ID de la key
ipfs key list -l | grep algocert-index-key

# 2. Intentar resolver IPNS
ipfs name resolve /ipns/k51qzi5uqu5dhonp113olftb52kmnb3vo9nvyc20910k7nk1pgurprtwp3b0sb

# Si ya hay índice publicado, devuelve:
# /ipfs/QmeNvSSa...

# Si no hay nada publicado aún:
# Error: could not resolve name

# Esto es NORMAL si nunca se ha publicado, continuamos
```

**✅ Verificación exitosa si:** Los 3 nodos tienen el MISMO ID de key.

---

## Paso 6: Crear Script de Sincronización

### En CADA Nodo (194, 193, 192)

```bash
# 1. Crear el script
sudo nano /usr/local/bin/ipfs-sync-index.sh
```

**Pegar este contenido:**

```bash
#!/bin/bash
IPNS_KEY="k51qzi5uqu5dhonp113olftb52kmnb3vo9nvyc20910k7nk1pgurprtwp3b0sb"
LOG_FILE="/var/log/ipfs-index-sync.log"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" | tee -a "$LOG_FILE"; }

log "=========================================="
log "🔄 Iniciando sincronización de índice IPFS"

# Esperar a que IPFS esté listo
log "⏳ Esperando a que IPFS esté listo..."
for i in {1..10}; do
    if ipfs id > /dev/null 2>&1; then
        log "✅ IPFS listo (intento $i/10)"
        break
    fi
    if [ $i -eq 10 ]; then
        log "❌ IPFS no respondió, abortando"
        exit 1
    fi
    sleep 3
done

sleep 5

# Resolver IPNS
log "🔍 Resolviendo IPNS: /ipns/$IPNS_KEY"
IPNS_CID=""
for i in {1..3}; do
    IPNS_CID=$(ipfs name resolve /ipns/$IPNS_KEY 2>&1 | grep -oP '/ipfs/\K\w+')
    if [ -n "$IPNS_CID" ]; then
        log "✅ IPNS resuelto: $IPNS_CID"
        break
    fi
    [ $i -lt 3 ] && log "⏳ Reintentando... ($i/3)" && sleep 2
done

if [ -z "$IPNS_CID" ]; then
    log "⚠️  No se pudo resolver IPNS - manteniendo índice local"
    log "=========================================="
    exit 0
fi

# Comparar CID local con IPNS
LOCAL_CID=$(ipfs files stat /cert-index --hash 2>/dev/null | head -n1)

if [ "$LOCAL_CID" == "$IPNS_CID" ]; then
    log "✅ Índice ya sincronizado (CID: $LOCAL_CID)"
    log "=========================================="
    exit 0
fi

# Sincronizar índice
log "🔄 Sincronizando índice:"
log "   Local: ${LOCAL_CID:-vacío}"
log "   IPNS:  $IPNS_CID"

# Backup si existe
BACKUP_PATH=""
if ipfs files stat /cert-index > /dev/null 2>&1; then
    BACKUP_PATH="/cert-index-backup-$(date +%s)"
    if ipfs files cp /cert-index $BACKUP_PATH 2>/dev/null; then
        log "📦 Backup: $BACKUP_PATH"
    fi
fi

# Copiar nuevo índice
ipfs files rm -r /cert-index 2>/dev/null

if ipfs files cp /ipfs/$IPNS_CID /cert-index 2>&1 | tee -a "$LOG_FILE"; then
    log "✅ Índice copiado desde IPNS"
    
    # Verificar
    NEW_CID=$(ipfs files stat /cert-index --hash 2>/dev/null | head -n1)
    if [ "$NEW_CID" == "$IPNS_CID" ]; then
        log "✅ Verificación OK: $NEW_CID"
        
        # Limpiar backups antiguos
        BACKUP_COUNT=$(ipfs files ls / 2>/dev/null | grep -c "cert-index-backup-" || echo 0)
        if [ "$BACKUP_COUNT" -gt 3 ]; then
            log "🧹 Limpiando backups antiguos..."
            ipfs files ls / | grep "cert-index-backup-" | sort | head -n -3 | while read backup; do
                ipfs files rm -r "/$backup" 2>/dev/null
            done
        fi
    else
        log "⚠️  Verificación falló: $NEW_CID != $IPNS_CID"
    fi
else
    log "❌ Error al copiar índice"
    if [ -n "$BACKUP_PATH" ]; then
        log "🔄 Restaurando backup..."
        ipfs files cp $BACKUP_PATH /cert-index 2>&1 | tee -a "$LOG_FILE"
    fi
    exit 1
fi

log "=========================================="
log "✅ Sincronización completada"
log "=========================================="
```

```bash
# 2. Dar permisos de ejecución
sudo chmod +x /usr/local/bin/ipfs-sync-index.sh

# 3. Crear archivo de log
sudo touch /var/log/ipfs-index-sync.log
sudo chown $(whoami):$(whoami) /var/log/ipfs-index-sync.log
```

---

## Paso 7: Crear Servicio IPFS

### En Nodo 194

```bash
sudo nano /etc/systemd/system/ipfs.service
```

**Contenido:**

```ini
[Unit]
Description=IPFS Daemon
After=network.target

[Service]
Type=simple
User=jmarcatoma
Group=jmarcatoma
Environment="IPFS_PATH=/home/jmarcatoma/.ipfs"
ExecStart=/usr/local/bin/ipfs daemon
ExecStartPost=/bin/sleep 10
ExecStartPost=/usr/local/bin/ipfs-sync-index.sh
Restart=on-failure
RestartSec=10s
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
```

### En Nodo 193

```bash
sudo nano /etc/systemd/system/ipfs.service
```

**Contenido (cambiar usuario):**

```ini
[Unit]
Description=IPFS Daemon
After=network.target

[Service]
Type=simple
User=nodo1
Group=nodo1
Environment="IPFS_PATH=/home/nodo1/.ipfs"
ExecStart=/usr/local/bin/ipfs daemon
ExecStartPost=/bin/sleep 10
ExecStartPost=/usr/local/bin/ipfs-sync-index.sh
Restart=on-failure
RestartSec=10s
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
```

### En Nodo 192

```bash
sudo nano /etc/systemd/system/ipfs.service
```

**Contenido (cambiar usuario):**

```ini
[Unit]
Description=IPFS Daemon
After=network.target

[Service]
Type=simple
User=nodo3
Group=nodo3
Environment="IPFS_PATH=/home/nodo3/.ipfs"
ExecStart=/usr/local/bin/ipfs daemon
ExecStartPost=/bin/sleep 10
ExecStartPost=/usr/local/bin/ipfs-sync-index.sh
Restart=on-failure
RestartSec=10s
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
```

---

## Paso 8: Crear Servicio IPFS Cluster

### En CADA Nodo (ajustar usuario por nodo)

```bash
sudo nano /etc/systemd/system/ipfs-cluster.service
```

**Nodo 194:**

```ini
[Unit]
Description=IPFS Cluster Service
After=ipfs.service
Requires=ipfs.service

[Service]
Type=simple
User=jmarcatoma
Group=jmarcatoma
ExecStart=/usr/local/bin/ipfs-cluster-service daemon
Restart=on-failure
RestartSec=10s

[Install]
WantedBy=multi-user.target
```

**Nodo 193:** (cambiar User=nodo1 y Group=nodo1)

**Nodo 192:** (cambiar User=nodo3 y Group=nodo3)

---

## Paso 9: Activar Servicios

### En CADA Nodo (194, 193, 192)

```bash
# 1. Detener procesos manuales si existen
pkill ipfs-cluster-service
pkill ipfs
sleep 3

# 2. Recargar systemd
sudo systemctl daemon-reload

# 3. Habilitar servicios (auto-inicio)
sudo systemctl enable ipfs.service
sudo systemctl enable ipfs-cluster.service

# 4. Iniciar IPFS
sudo systemctl start ipfs.service

# 5. Esperar 15 segundos
sleep 15

# 6. Verificar estado de IPFS
systemctl status ipfs.service

# Debe mostrar: Active: active (running)

# 7. Ver logs de sync
tail -20 /var/log/ipfs-index-sync.log

# 8. Iniciar cluster
sudo systemctl start ipfs-cluster.service

# 9. Verificar cluster
systemctl status ipfs-cluster.service
```

---

## Paso 10: Verificación Final

### En Cada Nodo

```bash
# 1. Verificar que IPFS responde
ipfs id

# 2. Verificar que cluster está corriendo
ipfs-cluster-ctl peers ls

# 3. Ver logs de sincronización
tail -f /var/log/ipfs-index-sync.log

# 4. Verificar que /cert-index existe
ipfs files ls /cert-index
```

---

## Paso 11: Crear Scripts de Usuario

### Script de Reinicio Completo

```bash
nano ~/restart-ipfs-sync.sh
```

```bash
#!/bin/bash
echo "🔄 Reiniciando IPFS y forzando sincronización..."
sudo systemctl stop ipfs-cluster.service
sudo systemctl stop ipfs.service
sleep 3
sudo systemctl start ipfs.service
sleep 10
sudo /usr/local/bin/ipfs-sync-index.sh
sudo systemctl start ipfs-cluster.service
sleep 5
echo "✅ Completado"
systemctl status ipfs.service --no-pager
systemctl status ipfs-cluster.service --no-pager
```

```bash
chmod +x ~/restart-ipfs-sync.sh
```

### Script de Sync Rápido

```bash
nano ~/sync-now.sh
```

```bash
#!/bin/bash
echo "🔄 Sincronizando índice IPFS ahora..."
sudo /usr/local/bin/ipfs-sync-index.sh
echo "📋 Ver log: tail -20 /var/log/ipfs-index-sync.log"
```

```bash
chmod +x ~/sync-now.sh
```

---

## 📊 Resumen de Archivos Creados

| Archivo | Ubicación | Propósito |
|---------|-----------|-----------|
| ipfs-sync-index.sh | /usr/local/bin/ | Script de sincronización |
| ipfs.service | /etc/systemd/system/ | Servicio IPFS |
| ipfs-cluster.service | /etc/systemd/system/ | Servicio Cluster |
| ipfs-index-sync.log | /var/log/ | Log de sincronización |
| restart-ipfs-sync.sh | ~/ | Reinicio manual |
| sync-now.sh | ~/ | Sync rápido |

---

## 🧪 Pruebas de Funcionamiento

### Test 1: Auto-inicio

```bash
# Reiniciar servidor
sudo reboot

# Después del boot, verificar:
systemctl status ipfs.service
systemctl status ipfs-cluster.service
tail -f /var/log/ipfs-index-sync.log
```

### Test 2: Failover

```bash
# En nodo 194, apagar IPFS
sudo systemctl stop ipfs.service

# El backend debería cambiar automáticamente a 193

# Reiniciar 194
sudo systemctl start ipfs.service

# Ver logs - debería sincronizar automáticamente
tail -f /var/log/ipfs-index-sync.log
```

### Test 3: Sincronización Manual

```bash
# Forzar sync sin reiniciar
~/sync-now.sh

# Reinicio completo
~/restart-ipfs-sync.sh
```

---

## ✅ Checklist de Verificación

- [ ] IPNS key exportada del nodo 194
- [ ] Key importada en nodo 193
- [ ] Key importada en nodo 192
- [ ] Mismo key ID en los 3 nodos
- [ ] Script de sync creado en los 3 nodos
- [ ] Servicio ipfs.service creado en los 3 nodos
- [ ] Servicio ipfs-cluster.service creado en los 3 nodos
- [ ] Usuario correcto en cada servicio
- [ ] Servicios habilitados (auto-inicio)
- [ ] Servicios iniciados y funcionando
- [ ] Log de sync funciona
- [ ] Scripts de usuario creados
- [ ] Test de failover exitoso

---

## 🚨 Troubleshooting

### Servicio no inicia

```bash
# Ver error detallado
sudo journalctl -u ipfs.service -n 50

# Verificar usuario
systemctl cat ipfs.service | grep User

# Debe coincidir con: whoami
```

### IPNS no resuelve

```bash
# Verificar key
ipfs key list -l | grep algocert-index-key

# Probar resolución manual
ipfs name resolve /ipns/k51qzi5uqu5d...

# Ver logs de sync
tail -f /var/log/ipfs-index-sync.log
```

### Sync falla

```bash
# Ver proceso ipfs
ps aux | grep "ipfs daemon"

# Probar comando manual
ipfs id
ipfs files ls /cert-index

# Ejecutar script manualmente
sudo /usr/local/bin/ipfs-sync-index.sh
```

---

## 📝 Notas Finales

- **Auto-inicio:** Los servicios inician automáticamente al bootear
- **Logs:** Revisar /var/log/ipfs-index-sync.log para debugging
- **Sync manual:** Usar ~/sync-now.sh cuando sea necesario
- **Backups:** El script mantiene los últimos 3 backups automáticamente
- **Usuario:** Asegurar usuario correcto en cada nodo

**Sistema completo y funcional.** 🎉
