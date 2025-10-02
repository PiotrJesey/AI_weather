:: ----------------------
:: Kudu Deployment Script for Node.js backend
:: ----------------------

@echo off
:: Setup paths
IF NOT DEFINED DEPLOYMENT_SOURCE (
  SET DEPLOYMENT_SOURCE=%~dp0.
)
IF NOT DEFINED DEPLOYMENT_TARGET (
  SET DEPLOYMENT_TARGET=%HOME%\site\wwwroot
)
IF NOT DEFINED DEPLOYMENT_TEMP (
  SET DEPLOYMENT_TEMP=%HOME%\site\deployments\temp
)
IF NOT DEFINED DEPLOYMENT_LOG (
  SET DEPLOYMENT_LOG=%HOME%\site\deployments\log.txt
)

echo Handling Node.js deployment.

:: 1. Select Node.js version (if KUDU_SELECT_NODE_VERSION available)
IF DEFINED KUDU_SELECT_NODE_VERSION (
  call %KUDU_SELECT_NODE_VERSION% "%DEPLOYMENT_SOURCE%" "%DEPLOYMENT_TARGET%" "%DEPLOYMENT_TEMP%"
)

:: 2. Install Node modules
IF EXIST "%DEPLOYMENT_SOURCE%\package.json" (
  pushd "%DEPLOYMENT_SOURCE%"
  echo Installing npm packages (omit dev dependencies)...
  call :ExecuteCmd npm install --omit=dev
  popd
)

:: 3. Copy app files to wwwroot (exclude node_modules)
echo Copying files to %DEPLOYMENT_TARGET%
robocopy "%DEPLOYMENT_SOURCE%" "%DEPLOYMENT_TARGET%" /E /XD node_modules /NFL /NDL /NJH /NJS /nc /ns /np
IF %ERRORLEVEL% LSS 8 SET ERRORLEVEL = 0

goto end

:: Helper function
:ExecuteCmd
setlocal
set CMD=%*
call %CMD%
if "%ERRORLEVEL%" NEQ "0" goto error
endlocal
goto :EOF

:error
echo An error occurred during deployment.
exit /b 1

:end
echo Deployment finished successfully.
