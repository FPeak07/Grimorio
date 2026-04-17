#!/bin/bash
set -e

echo "=== Grimorio — Build para macOS ==="

echo "Instalando dependencias..."
pip install pyinstaller pillow flask --quiet

echo "Compilando binario..."
pyinstaller grimorio.spec --clean --noconfirm

echo "Convirtiendo logo a .icns..."
python3 - << 'PYEOF'
from PIL import Image
img = Image.open("Logo.png").convert("RGBA")
bbox = img.getbbox()
img = img.crop(bbox)
w, h = img.size
side = max(w, h)
square = Image.new("RGBA", (side, side), (0, 0, 0, 0))
square.paste(img, ((side - w) // 2, (side - h) // 2))
square.save("_logo_trimmed.png")
PYEOF
mkdir -p logo.iconset
for size in 16 32 64 128 256 512; do
    sips -z $size $size -s format png _logo_trimmed.png --out logo.iconset/icon_${size}x${size}.png > /dev/null
done
sips -z 32   32   -s format png _logo_trimmed.png --out logo.iconset/icon_16x16@2x.png   > /dev/null
sips -z 64   64   -s format png _logo_trimmed.png --out logo.iconset/icon_32x32@2x.png   > /dev/null
sips -z 256  256  -s format png _logo_trimmed.png --out logo.iconset/icon_128x128@2x.png > /dev/null
sips -z 512  512  -s format png _logo_trimmed.png --out logo.iconset/icon_256x256@2x.png > /dev/null
sips -z 1024 1024 -s format png _logo_trimmed.png --out logo.iconset/icon_512x512@2x.png > /dev/null
iconutil -c icns logo.iconset -o logo.icns
rm -rf logo.iconset _logo_trimmed.png

echo "Creando Grimorio.app..."
rm -rf dist/Grimorio.app
mkdir -p dist/Grimorio.app/Contents/MacOS
mkdir -p dist/Grimorio.app/Contents/Resources

# Icono
cp logo.icns dist/Grimorio.app/Contents/Resources/logo.icns

# Binario y dependencias dentro del bundle
cp -r dist/Grimorio/* dist/Grimorio.app/Contents/Resources/

# Launcher: abre Terminal.app y ejecuta el binario dentro
cat > dist/Grimorio.app/Contents/MacOS/Grimorio << 'EOF'
#!/bin/bash
RESOURCES="$(cd "$(dirname "$0")/../Resources" && pwd)"
osascript << APPLESCRIPT
tell application "Terminal"
    activate
    do script "exec '$RESOURCES/Grimorio'"
end tell
APPLESCRIPT
EOF
chmod +x dist/Grimorio.app/Contents/MacOS/Grimorio

# Info.plist
cat > dist/Grimorio.app/Contents/Info.plist << 'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleExecutable</key>      <string>Grimorio</string>
    <key>CFBundleIdentifier</key>     <string>com.grimorio.app</string>
    <key>CFBundleName</key>           <string>Grimorio</string>
    <key>CFBundlePackageType</key>    <string>APPL</string>
    <key>CFBundleShortVersionString</key><string>1.0.0</string>
    <key>NSHighResolutionCapable</key><true/>
    <key>NSPrincipalClass</key>       <string>NSApplication</string>
    <key>CFBundleIconFile</key>       <string>logo</string>
</dict>
</plist>
EOF

echo ""
echo "Listo: dist/Grimorio.app"
echo "  Muevela a /Applications o ejecutala con doble clic."
echo "  Al abrirla se abre Terminal — cierra Terminal para salir."
echo ""
echo "  Datos en: ~/Library/Application Support/Grimorio/"
