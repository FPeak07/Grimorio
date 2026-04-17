@echo off
echo === Grimorio - Build para Windows ===

echo Instalando dependencias...
pip install pyinstaller pillow flask

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
