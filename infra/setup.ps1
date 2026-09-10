<#
.SYNOPSIS
    Crea y conecta los recursos que le faltan a la Static Web App del grabador.

.DESCRIPTION
    1. Lee el hostname real de la Static Web App
    2. Crea la cuenta de almacenamiento y el contenedor de audio
    3. Configura el CORS del blob con el dominio de la SWA (sin esto la subida falla)
    4. Crea el recurso de Azure AI Speech
    5. Carga las variables de entorno en la SWA, sin que los secretos pasen por el portapapeles

    Es idempotente: volver a ejecutarlo sobre recursos existentes no los rompe.

.NOTES
    Requiere Azure CLI y una sesion iniciada:
        winget install Microsoft.AzureCLI
        az login

    Crea recursos facturables: una cuenta Standard_LRS y un Speech S0 (pago por uso).

.EXAMPLE
    .\infra\setup.ps1
#>

[CmdletBinding()]
param(
    [string]$ResourceGroup = "rg-claudio.castillo-5783",
    [string]$SwaName       = "GRABACIONAUDIO",
    [string]$Location      = "westeurope",
    [string]$StorageName   = "",
    [string]$SpeechName    = "",
    [string]$Container     = "grabaciones",
    [int]$SasTtlMinutes    = 15
)

$ErrorActionPreference = "Stop"

function Invoke-Az {
    param([string[]]$Args, [string]$Step)
    $out = & az @Args 2>&1
    if ($LASTEXITCODE -ne 0) {
        Write-Host "`n  FALLO: $Step" -ForegroundColor Red
        Write-Host ($out | Out-String)
        throw "az fallo en: $Step"
    }
    return ($out | Out-String).Trim()
}

function Write-Step { param([string]$m) Write-Host "`n> $m" -ForegroundColor Cyan }

# nombres unicos si no se pasaron por parametro
$suffix = -join ((1..6) | ForEach-Object { Get-Random -Minimum 0 -Maximum 10 })
if ([string]::IsNullOrWhiteSpace($StorageName)) { $StorageName = "stgrabacion$suffix" }
if ([string]::IsNullOrWhiteSpace($SpeechName))  { $SpeechName  = "speech-grabacion-$suffix" }

Write-Host "=== Configuracion de infraestructura del grabador ===" -ForegroundColor White
Write-Host "  Grupo de recursos : $ResourceGroup"
Write-Host "  Static Web App    : $SwaName"
Write-Host "  Region            : $Location"
Write-Host "  Almacenamiento    : $StorageName"
Write-Host "  Speech            : $SpeechName"
Write-Host "  Contenedor        : $Container"

Write-Step "Verificando sesion de Azure"
$acct = Invoke-Az @("account", "show", "--query", "{n:name,id:id}", "-o", "tsv") "az account show"
Write-Host "  Suscripcion: $acct"

Write-Step "Leyendo el hostname de la Static Web App"
$hostName = Invoke-Az @("staticwebapp", "show", "--name", $SwaName, "--resource-group", $ResourceGroup,
                        "--query", "defaultHostname", "-o", "tsv") "staticwebapp show"
$origin = "https://$hostName"
Write-Host "  URL del sitio: $origin"

Write-Step "Creando la cuenta de almacenamiento (si no existe)"
$exists = & az storage account show --name $StorageName --resource-group $ResourceGroup --query name -o tsv 2>$null
if ($LASTEXITCODE -eq 0 -and $exists) {
    Write-Host "  Ya existe: $StorageName"
} else {
    Invoke-Az @("storage", "account", "create", "--name", $StorageName, "--resource-group", $ResourceGroup,
                "--location", $Location, "--sku", "Standard_LRS", "--kind", "StorageV2",
                "--min-tls-version", "TLS1_2", "--allow-blob-public-access", "false",
                "-o", "none") "crear cuenta de almacenamiento"
    Write-Host "  Creada: $StorageName"
}

Write-Step "Obteniendo la connection string"
$conn = Invoke-Az @("storage", "account", "show-connection-string", "--name", $StorageName,
                    "--resource-group", $ResourceGroup, "--query", "connectionString",
                    "-o", "tsv") "show-connection-string"

Write-Step "Creando el contenedor privado '$Container'"
Invoke-Az @("storage", "container", "create", "--name", $Container,
            "--connection-string", $conn, "--public-access", "off", "-o", "none") "crear contenedor"
Write-Host "  Listo"

Write-Step "Configurando CORS del blob para $origin"
# se limpia primero para no acumular reglas duplicadas al re-ejecutar
Invoke-Az @("storage", "cors", "clear", "--services", "b",
            "--connection-string", $conn, "-o", "none") "limpiar CORS"
Invoke-Az @("storage", "cors", "add", "--services", "b",
            "--methods", "PUT", "OPTIONS",
            "--origins", $origin, "http://localhost:5500", "http://localhost:8000",
            "--allowed-headers", "x-ms-blob-type,x-ms-blob-content-type,x-ms-meta-*,content-type",
            "--exposed-headers", "*", "--max-age", "3600",
            "--connection-string", $conn, "-o", "none") "agregar CORS"
Write-Host "  Origenes autorizados: $origin, localhost:5500, localhost:8000"

Write-Step "Creando el recurso de Azure AI Speech (si no existe)"
$sp = & az cognitiveservices account show --name $SpeechName --resource-group $ResourceGroup --query name -o tsv 2>$null
if ($LASTEXITCODE -eq 0 -and $sp) {
    Write-Host "  Ya existe: $SpeechName"
} else {
    Invoke-Az @("cognitiveservices", "account", "create", "--name", $SpeechName,
                "--resource-group", $ResourceGroup, "--location", $Location,
                "--kind", "SpeechServices", "--sku", "S0", "--yes", "-o", "none") "crear Speech"
    Write-Host "  Creado: $SpeechName"
}

$speechKey = Invoke-Az @("cognitiveservices", "account", "keys", "list", "--name", $SpeechName,
                         "--resource-group", $ResourceGroup, "--query", "key1", "-o", "tsv") "keys list"

Write-Step "Cargando las variables de entorno en la Static Web App"
Invoke-Az @("staticwebapp", "appsettings", "set", "--name", $SwaName, "--resource-group", $ResourceGroup,
            "--setting-names",
            "AUDIO_STORAGE_CONNECTION=$conn",
            "AUDIO_CONTAINER=$Container",
            "SPEECH_KEY=$speechKey",
            "SPEECH_REGION=$Location",
            "SAS_TTL_MINUTES=$SasTtlMinutes",
            "-o", "none") "appsettings set"

$names = Invoke-Az @("staticwebapp", "appsettings", "list", "--name", $SwaName,
                     "--resource-group", $ResourceGroup,
                     "--query", "properties | keys(@)", "-o", "tsv") "appsettings list"
Write-Host "  Variables cargadas: $($names -replace '\s+', ', ')"

Write-Host "`n=== Listo ===" -ForegroundColor Green
Write-Host "  Sitio        : $origin"
Write-Host "  Almacenamiento: $StorageName / $Container ($Location)"
Write-Host "  Speech        : $SpeechName ($Location)"
Write-Host "`nLos secretos quedaron en la configuracion de la SWA; no se muestran aca." -ForegroundColor Yellow
Write-Host "Guarda estos nombres, los vas a necesitar para diagnosticar." -ForegroundColor Yellow
Write-Host "`nProbar: abre $origin, ingresa un ID, graba unos segundos y sube." -ForegroundColor White
