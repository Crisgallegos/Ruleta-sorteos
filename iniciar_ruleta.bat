@echo off
title Ruleta de Sorteos Pro - Servidor
cls
echo ======================================================
echo       RULETA DE SORTEOS PRO - INICIANDO SERVIDOR
echo ======================================================
echo.
echo Iniciando servidor de sincronizacion PC y Celular...
echo.
start "" http://localhost:3000
node server.js
pause
