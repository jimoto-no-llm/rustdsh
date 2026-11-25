@echo off
rem Fixture stand-in for curl in tests/provider_cli.rs (Windows edition).
rem rdsh invokes `curl -q --config -`, so the request URL arrives on stdin as
rem a config line rather than in argv. Answer GET {base}/models with a model
rem list and fail every other request closed, so --discover never reaches a
rem network.
setlocal EnableDelayedExpansion
set "url="
for /f "usebackq delims=" %%L in (`findstr /R "^url = "`) do set "url=%%L"
if defined url (
  echo !url! | findstr /C:"/models" >nul
  if not errorlevel 1 (
    echo {"data":[{"id":"fixture-model"}]}
    exit /b 0
  )
)
echo fixture curl: unexpected request 1>&2
exit /b 22
