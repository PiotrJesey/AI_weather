:: ----------------------
:: Kudu Deployment Script
:: ----------------------

@echo off
:: Setup
IF NOT DEFINED DEPLOYMENT_SOURCE (
  SET DEPLOYMENT_SOURCE=%~dp0.
)

IF NOT DEFINED DEPLOYMENT_TARGET (
  SET DEPLOYMENT_TARGET=%HOME%\site\wwwroot
)

IF NOT DEFINED NEXT_MANIFEST_PATH (
  SET NEXT_MANIFEST_PATH=%HOME%\site\deployments\manifest
)

IF NOT DEFINED PREVIOUS_MANIFEST_PATH (
  SET PREVIOUS_MANIFEST_PATH=%HOME%\site\deployments\previousManifest
)

IF NOT DEFINED DEPLOYMENT_TEMP (
  SET DEPLOYMENT_TEMP=%HOME%\site\deployments\temp
)

IF NOT DEFINED DEPLOYMENT_LOG (
  SET DEPLOYMENT_LOG=%HOME%\site\deployments\log.txt
)

IF NOT DEFINED DEPLOYMENT_CACHE (
  SET DEPLOYMENT_CACHE=%HOME%\site\deployments\cache
)

echo Handling Node.js backend deployment.

:: 1. Select Node.js version
IF DEFINED KUDU_SELECT_NODE_VERSION (
  call %KUDU_SELECT_NODE_VERSION% "%DEPLOYMENT_SOURCE%" "%DEPLOYMENT_TARGET%" "%DEPLOYMENT_TEMP%"
)

:: 2. Install Node modules
IF EXIST "%DEPLOYMENT_SOURCE%\package.json" (
  pushd "%DEPLOYMENT_SOURCE%"
  echo Installing npm packages...
  call :ExecuteCmd npm install --production
  popd
)

:: 3. Copy app files to wwwroot (excluding node_modules)
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
echo Finished successfully.
