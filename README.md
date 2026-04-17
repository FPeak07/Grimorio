# Grimorio — Árbol de Conocimiento

Aplicación local para organizar conocimiento en forma de árbol visual al estilo RPG. Cada nodo puede tener título, contenido en Markdown, imágenes, color, forma e icono. Exporta a HTML autocontenido para compartir sin servidor.

---

## Requisitos

- **Python 3.9+**
- pip

---

## Instalación y uso (modo desarrollo)

```bash
git clone https://github.com/TU_USUARIO/grimorio.git
cd grimorio
pip install -r requirements.txt
python app.py
```

El navegador se abre automáticamente en `http://localhost:5001`.  
Para cerrar: **Ctrl+C** en la terminal.

---

## App nativa para macOS

Genera `Grimorio.app` (doble clic, sin necesitar Python instalado):

```bash
bash build_mac.sh
```

El resultado queda en `dist/Grimorio.app`.  
Puedes moverla a `/Applications`.

> Al abrirla se lanza una ventana de Terminal con el servidor.  
> Cierra esa ventana para salir.

Los datos se guardan en `~/Library/Application Support/Grimorio/`.

---

## Controles

| Acción | Cómo |
|---|---|
| Mover la vista | Arrastrar fondo con clic izquierdo |
| Zoom | Rueda del ratón |
| Crear nodo | Clic derecho sobre un nodo → elige forma |
| Mover nodo | Arrastrar el nodo |
| Editar nodo | Doble clic, o clic derecho → Editar |
| Ver contenido (HTML exportado) | Clic sobre el nodo |
| Abrir enlace (nodo URL) | Clic sobre el nodo |
| Conectar nodos | Clic derecho → Conectar → clic en otro nodo |
| Eliminar nodo | Clic derecho → Eliminar |
| Centrar vista | Botón ◎ |
| Exportar HTML compartible | Botón 📄 |
| Exportar / Importar JSON | Botones ↓ / ↑ |
| Cancelar / cerrar panel | Esc |

---

## Tipos de nodo

- **Nodo normal** — título, contenido Markdown, imágenes, color, forma
- **Nodo enlace** — abre una URL al hacer clic (icono 🔗)

---

## Estructura del proyecto

```
grimorio/
├── app.py              # Servidor Flask
├── requirements.txt
├── grimorio.spec       # Configuración PyInstaller
├── build_mac.sh        # Script de compilación macOS
├── build_windows.bat   # Script de compilación Windows
├── Logo.png            # Icono de la app
├── templates/
│   └── index.html
├── static/
│   ├── app.js
│   └── style.css
└── images/             # Imágenes subidas (generada automáticamente)
```

`tree_data.json` se crea automáticamente al primer arranque.

---

## Datos y privacidad

Todo es local. Ningún dato sale de tu máquina.  
Backup: copia `tree_data.json` e `images/`.
