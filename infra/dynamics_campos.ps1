<#
.SYNOPSIS
  Crea en la tabla Caso (incident) los campos que completa la pestaña en vivo:
  datos del socio, datos de la solicitud y la clasificación de la atención.

.DESCRIPTION
  Usa la Web API de Dataverse con el token de la sesión de Azure CLI (az login),
  así que actúa con los permisos de quien lo ejecuta (requiere rol de
  personalizador del sistema). Es idempotente: un campo que ya existe no se toca,
  salvo las listas de opciones, a las que se agregan las opciones del catálogo
  que les falten (assets/catalogo.json). Nunca borra opciones.

  Los campos quedan en la solución indicada y se publican. NO los agrega al
  formulario: eso se hace en el diseñador (ver dynamics/README.md).

  Guardado como UTF-8 con BOM: Windows PowerShell 5.1 lee un .ps1 sin BOM como
  ANSI y las tildes de las etiquetas llegarían rotas a Dynamics.

.EXAMPLE
  .\infra\dynamics_campos.ps1
  .\infra\dynamics_campos.ps1 -Org https://otroambiente.crm2.dynamics.com -Solucion MiSolucion -Prefijo abc
#>
param(
    [string]$Org      = "https://demolegrand.crm2.dynamics.com",
    [string]$Solucion = "DemoLandingsWIT",
    [string]$Prefijo  = "wit",
    [string]$Catalogo = (Join-Path $PSScriptRoot "..\assets\catalogo.json")
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

function Enviar([string]$metodo, [string]$uri, $cuerpo) {
    $json = $cuerpo | ConvertTo-Json -Depth 12
    Invoke-RestMethod -Method $metodo -Headers $cabeceras -ContentType "application/json; charset=utf-8" `
        -Uri $uri -Body ([System.Text.Encoding]::UTF8.GetBytes($json))
}

$nivel = @{ "Value" = "None"; "CanBeChanged" = $true
            "ManagedPropertyLogicalName" = "canmodifyrequirementlevelsettings" }

function CampoTexto([string]$schema, [string]$nombre, [string]$desc, [int]$largo, [string]$formato = "Text") {
    @{ "@odata.type" = "Microsoft.Dynamics.CRM.StringAttributeMetadata"
       "SchemaName" = "${Prefijo}_$schema"; "DisplayName" = Etiqueta $nombre
       "Description" = Etiqueta $desc; "RequiredLevel" = $nivel
       "MaxLength" = $largo; "FormatName" = @{ "Value" = $formato } }
}

function CampoMoneda([string]$schema, [string]$nombre, [string]$desc) {
    @{ "@odata.type" = "Microsoft.Dynamics.CRM.MoneyAttributeMetadata"
       "SchemaName" = "${Prefijo}_$schema"; "DisplayName" = Etiqueta $nombre
       "Description" = Etiqueta $desc; "RequiredLevel" = $nivel
       "PrecisionSource" = 2          # la precisión de la moneda del registro
       "MinValue" = 0; "MaxValue" = 100000000000 }
}

function CampoEntero([string]$schema, [string]$nombre, [string]$desc, [int]$min, [int]$max) {
    @{ "@odata.type" = "Microsoft.Dynamics.CRM.IntegerAttributeMetadata"
       "SchemaName" = "${Prefijo}_$schema"; "DisplayName" = Etiqueta $nombre
       "Description" = Etiqueta $desc; "RequiredLevel" = $nivel
       "Format" = "None"; "MinValue" = $min; "MaxValue" = $max }
}

function CampoDecimal([string]$schema, [string]$nombre, [string]$desc) {
    @{ "@odata.type" = "Microsoft.Dynamics.CRM.DecimalAttributeMetadata"
       "SchemaName" = "${Prefijo}_$schema"; "DisplayName" = Etiqueta $nombre
       "Description" = Etiqueta $desc; "RequiredLevel" = $nivel
       "Precision" = 2; "MinValue" = 0; "MaxValue" = 100 }
}

function CampoMemo([string]$schema, [string]$nombre, [string]$desc, [int]$largo) {
    @{ "@odata.type" = "Microsoft.Dynamics.CRM.MemoAttributeMetadata"
       "SchemaName" = "${Prefijo}_$schema"; "DisplayName" = Etiqueta $nombre
       "Description" = Etiqueta $desc; "RequiredLevel" = $nivel
       "MaxLength" = $largo; "Format" = "TextArea" }
}

function CampoLista([string]$schema, [string]$nombre, [string]$desc, [string[]]$opciones) {
    $i = 0
    $ops = @($opciones | ForEach-Object {
        @{ "Value" = 100000000 + $i; "Label" = Etiqueta $_ }; $i++ })
    @{ "@odata.type" = "Microsoft.Dynamics.CRM.PicklistAttributeMetadata"
       "SchemaName" = "${Prefijo}_$schema"; "DisplayName" = Etiqueta $nombre
       "Description" = Etiqueta $desc; "RequiredLevel" = $nivel
       "OptionSet" = @{ "@odata.type" = "Microsoft.Dynamics.CRM.OptionSetMetadata"
                        "IsGlobal" = $false; "OptionSetType" = "Picklist"; "Options" = $ops } }
}

# ---- catálogo: las opciones de las tres listas salen de aquí ----------------
$cat = Get-Content -Raw -Encoding UTF8 $Catalogo | ConvertFrom-Json
$clasificaciones = @($cat.clasificaciones | ForEach-Object { $_.nombre }) | Select-Object -Unique
$motivos         = @($cat.clasificaciones | ForEach-Object { $_.motivos } | ForEach-Object { $_.nombre }) | Select-Object -Unique
$submotivos      = @($cat.clasificaciones | ForEach-Object { $_.motivos } | ForEach-Object { $_.submotivos }) | Select-Object -Unique
$productos       = @($cat.productos)
$respuestas      = @($cat.respuestas)
$demo = if ($cat.demo) { " [catálogo de demo]" } else { "" }

$origen = "confirmado desde la grabación en vivo."
$campos = @(
    (CampoMoneda "MontoSolicitado"   "Monto solicitado"   "Monto del crédito que pide el cliente, $origen"),
    (CampoMoneda "IngresosMensuales" "Ingresos mensuales" "Ingreso mensual del cliente, $origen"),
    (CampoTexto  "Rut"               "RUT"                "RUT del cliente (12.345.678-5), $origen" 12),
    (CampoTexto  "Nombre"            "Nombre"             "Nombre del socio, $origen" 100),
    (CampoTexto  "ApellidoPaterno"   "Apellido paterno"   "Apellido paterno del socio, $origen" 100),
    (CampoTexto  "ApellidoMaterno"   "Apellido materno"   "Apellido materno del socio, $origen" 100),
    (CampoTexto  "Telefono"          "Teléfono"           "Teléfono de contacto del socio, $origen" 20 "Phone"),
    (CampoLista  "Clasificacion"     "Clasificación"      "Clasificación de la atención, $origen$demo" $clasificaciones),
    (CampoLista  "Motivo"            "Motivo"             "Motivo de la atención, $origen$demo" $motivos),
    (CampoLista  "Submotivo"         "Submotivo"          "Submotivo de la atención, $origen$demo" $submotivos),
    (CampoLista  "ProductoOfrecido"  "Producto ofrecido"  "Producto de la oferta comercial, $origen$demo" $productos),
    (CampoMoneda "CreditoPreaprobado" "Crédito preaprobado" "Monto preaprobado para el cliente; en producción lo carga la campaña. El grabador lo muestra como guía."),
    (CampoMoneda "MontoOferta"       "Monto oferta"       "Monto ofrecido al cliente, $origen"),
    (CampoEntero "PlazoMeses"        "Plazo (meses)"      "Plazo de la oferta en meses, $origen" 1 480),
    (CampoMoneda "ValorCuota"        "Valor cuota"        "Valor de la cuota mensual ofrecida, $origen"),
    (CampoDecimal "TasaMensual"      "Tasa mensual (%)"   "Tasa de interés mensual ofrecida, $origen"),
    (CampoDecimal "Cae"              "CAE (%)"            "Carga anual equivalente de la oferta, $origen"),
    (CampoLista  "RespuestaCliente"  "Respuesta del cliente" "Respuesta del cliente a la oferta, $origen$demo" $respuestas),
    (CampoMemo   "ComentariosGestion" "Comentarios de la gestión" "Registro de la gestión redactado a partir de la conversación y confirmado por el ejecutivo." 4000)
)

$base = "$api/EntityDefinitions(LogicalName='incident')/Attributes"
$existentes = (Invoke-RestMethod -Headers $cabeceras -Uri "$base`?`$select=LogicalName").value.LogicalName

$cambios = 0
foreach ($c in $campos) {
    $logico = $c.SchemaName.ToLower()
    if ($existentes -notcontains $logico) {
        Enviar "Post" $base $c | Out-Null
        Write-Host "  creado:    $logico"
        $cambios++
        continue
    }
    if ($c."@odata.type" -ne "Microsoft.Dynamics.CRM.PicklistAttributeMetadata") {
        Write-Host "  ya existe: $logico"
        continue
    }
    # lista existente: se agregan las opciones del catálogo que falten
    $actual = Invoke-RestMethod -Headers $cabeceras -Uri (
        "$base(LogicalName='$logico')/Microsoft.Dynamics.CRM.PicklistAttributeMetadata?`$expand=OptionSet")
    $etiquetas = @($actual.OptionSet.Options | ForEach-Object { $_.Label.UserLocalizedLabel.Label })
    $faltan = @($c.OptionSet.Options | ForEach-Object { $_.Label.LocalizedLabels[0].Label } |
                Where-Object { $etiquetas -notcontains $_ })
    foreach ($f in $faltan) {
        Enviar "Post" "$api/InsertOptionValue" @{
            "EntityLogicalName" = "incident"; "AttributeLogicalName" = $logico
            "Label" = Etiqueta $f; "SolutionUniqueName" = $Solucion } | Out-Null
        Write-Host "  opción agregada a ${logico}: $f"
        $cambios++
    }
    if (-not $faltan.Count) { Write-Host "  ya existe: $logico (opciones al día)" }
}

if ($cambios -gt 0) {
    $xml = "<importexportxml><entities><entity>incident</entity></entities></importexportxml>"
    Invoke-RestMethod -Method Post -Headers $cabeceras -ContentType "application/json" `
        -Uri "$api/PublishXml" -Body (@{ ParameterXml = $xml } | ConvertTo-Json) | Out-Null
    Write-Host "Publicado. Falta agregar los campos nuevos al formulario del Caso (ver dynamics/README.md)."
} else {
    Write-Host "Sin cambios."
}
