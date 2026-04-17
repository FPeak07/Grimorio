@echo off
echo === Grimorio - Build para Windows ===

echo Instalando dependencias...
pip install pyinstaller pillow flask

echo Generando logo.ico...
python -c "from PIL import Image; img=Image.open('Logo.png').convert('RGBA'); bbox=img.getbbox(); img=img.crop(bbox); w,h=img.size; s=max(w,h); sq=Image.new('RGBA',(s,s),(0,0,0,0)); sq.paste(img,((s-w)//2,(s-h)//2)); sq.save('logo.ico', format='ICO', sizes=[(16,16),(32,32),(48,48),(64,64),(128,128),(256,256)])"

echo Compilando...
pyinstaller grimorio.spec --clean --noconfirm

echo.
echo Listo: dist\Grimorio\Grimorio.exe
echo   Copia la carpeta dist\Grimorio\ a donde quieras y ejecuta Grimorio.exe
echo.
echo   Los datos del arbol se guardan en:
echo   %%APPDATA%%\Grimorio\
echo.
pause
