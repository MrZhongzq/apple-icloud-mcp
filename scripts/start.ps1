$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location -Path "$ScriptDir\.."

Write-Host "Starting Apple iCloud MCP..."

if (!(Get-Command node -ErrorAction SilentlyContinue))
{
    Write-Host "Node.js could not be found. Please install Node.js from https://nodejs.org/"
    exit 1
}

if (!(Get-Command npm -ErrorAction SilentlyContinue))
{
    Write-Host "npm could not be found. Please install Node.js."
    exit 1
}

Write-Host "Installing dependencies..."
npm install

Write-Host "Starting the server..."
npm start
