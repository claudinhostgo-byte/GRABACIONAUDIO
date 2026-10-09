<#
.SYNOPSIS
  Crea en la tabla Caso (incident) los campos de los datos de la solicitud:
  Monto solicitado, Ingresos mensuales y RUT.

.DESCRIPTION
  Usa la Web API de Dataverse con el token de la sesion de Azure CLI (az login),
  asi que actua con los permisos de quien lo ejecuta (requiere rol de
  personalizador del sistema). Es idempotente: un campo que ya existe no se toca.

  Los campos quedan en la solucion indicada y se publican. NO los agrega al
  formulario: eso se hace en el diseñador (ver dynamics/README.md).

.EXAMPLE
  .\infra\dynamics_campos.ps1
  .\infra\dynamics_campos.ps1 -Org https://otroambiente.crm2.dynamics.com -Solucion MiSolucion -Prefijo abc
#>
param(
    [string]$Org      = "https://demolegrand.crm2.dynamics.com",
    [string]$Solucion = "DemoLandingsWIT",
    [string]$Prefijo  = "wit"
)

$ErrorActionPreference = "Stop"
$Org = $Org.TrimEnd("/")
$api = "$Org/api/data/v9.2"

$token = az account get-access-token --resource $Org --query accessToken -o tsv
if (-not $token) { throw "No se obtuvo token. Ejecute 'az login' con un usuario del ambiente." }

$cabeceras = @{
    "Authorization"              = "Bearer $token"
    "Accept"                     = "application/json"
    "OData-MaxVersion"           = "4.0"
    "OData-Version"              = "4.0"
    "MSCRM.SolutionUniqueName"   = $Solucion
}

function Etiqueta([string]$texto) {
    @{ "@odata.type" = "Microsoft.Dynamics.CRM.Label"
       "LocalizedLabels" = @(@{ "@odata.type" = "Microsoft.Dynamics.CRM.LocalizedLabel"
                                "Label" = $texto; "LanguageCode" = 3082 }) }
}

$nivel = @{ "Value" = "None"; "CanBeChanged" = $true
            "ManagedPropertyLogicalName" = "canmodifyrequirementlevelsettings" }

$campos = @(
    @{
        "@odata.type"   = "Microsoft.Dynamics.CRM.MoneyAttributeMetadata"
        "SchemaName"    = "${Prefijo}_MontoSolicitado"
        "DisplayName"   = Etiqueta "Monto solicitado"
        "Description"   = Etiqueta "Monto del crédito que pide el cliente, confirmado desde la grabación en vivo."
        "RequiredLevel" = $nivel
        "PrecisionSource" = 2          # la precision de la moneda del registro
        "MinValue" = 0; "MaxValue" = 100000000000
    },
    @{
        "@odata.type"   = "Microsoft.Dynamics.CRM.MoneyAttributeMetadata"
        "SchemaName"    = "${Prefijo}_IngresosMensuales"
        "DisplayName"   = Etiqueta "Ingresos mensuales"
        "Description"   = Etiqueta "Ingreso mensual del cliente, confirmado desde la grabación en vivo."
        "RequiredLevel" = $nivel
        "PrecisionSource" = 2
        "MinValue" = 0; "MaxValue" = 100000000000
    },
    @{
        "@odata.type"   = "Microsoft.Dynamics.CRM.StringAttributeMetadata"
        "SchemaName"    = "${Prefijo}_Rut"
        "DisplayName"   = Etiqueta "RUT"
        "Description"   = Etiqueta "RUT del cliente (12.345.678-5), confirmado desde la grabación en vivo."
        "RequiredLevel" = $nivel
        "MaxLength"     = 12
        "FormatName"    = @{ "Value" = "Text" }
    }
)

$existentes = (Invoke-RestMethod -Headers $cabeceras -Uri (
    "$api/EntityDefinitions(LogicalName='incident')/Attributes?`$select=LogicalName")).value.LogicalName

$creados = 0
foreach ($c in $campos) {
    $logico = $c.SchemaName.ToLower()
    if ($existentes -contains $logico) {
        Write-Host "  ya existe: $logico"
        continue
    }
    $cuerpo = $c | ConvertTo-Json -Depth 10
    Invoke-RestMethod -Method Post -Headers $cabeceras -ContentType "application/json; charset=utf-8" `
        -Uri "$api/EntityDefinitions(LogicalName='incident')/Attributes" `
        -Body ([System.Text.Encoding]::UTF8.GetBytes($cuerpo)) | Out-Null
    Write-Host "  creado:    $logico"
    $creados++
}

if ($creados -gt 0) {
    $xml = "<importexportxml><entities><entity>incident</entity></entities></importexportxml>"
    Invoke-RestMethod -Method Post -Headers $cabeceras -ContentType "application/json" `
        -Uri "$api/PublishXml" -Body (@{ ParameterXml = $xml } | ConvertTo-Json) | Out-Null
    Write-Host "Publicado. Falta agregarlos al formulario del Caso (ver dynamics/README.md)."
} else {
    Write-Host "Sin cambios."
}
