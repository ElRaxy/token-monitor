# Token Monitor dentro de CodexBar

El fork público [ElRaxy/token-monitor](https://github.com/ElRaxy/token-monitor) incluye un provider local para mostrar un resumen pequeño de Token Monitor dentro del menú nativo de CodexBar. Usa la API oficial de plugins disponible desde **CodexBar 0.55.1**; no parchea Swift, no reemplaza la firma de la aplicación y no interfiere con sus actualizaciones.

La tarjeta presenta exactamente tres filas declarativas: **Hoy**, **Este mes** y **Actualizado**. Hoy y Este mes muestran tokens agregados y el coste únicamente cuando Token Monitor conoce un importe positivo. Actualizado muestra la marca absoluta `observedAt` en UTC, la antigüedad y el número de fuentes. No usa barras ni porcentajes porque los tokens consumidos no tienen un denominador de cuota fiable.

## Antes de instalar

- Ejecuta Token Monitor desde este fork y abre **Settings**.
- Activa el resumen para CodexBar. El servicio queda en `http://127.0.0.1:17322` y solo escucha en loopback local.
- Pulsa **Copy token** para copiar el bearer dedicado. No lo pegues en archivos versionados, URLs, capturas ni comandos compartidos.
- Instala o actualiza CodexBar a la versión 0.55.1 o posterior.

El endpoint exacto es `GET /api/integrations/codexbar/v1/summary`. Token Monitor responde desde su último snapshot en memoria: es una lectura **cache-only**, sin ejecutar collectors, probes ni refrescos nativos como efecto de una petición de CodexBar.

## Instalar el provider

El archivo versionado es [`integrations/codexbar/token-monitor.js`](../integrations/codexbar/token-monitor.js). Puedes elegirlo directamente desde **Settings → Plugins → Install…** en CodexBar o copiarlo a su carpeta de providers:

```bash
mkdir -p "$HOME/.config/codexbar/providers"
cp integrations/codexbar/token-monitor.js "$HOME/.config/codexbar/providers/token-monitor.js"
```

Después, en **Settings → Plugins**, abre `Token Monitor`, revisa su autoridad y configura:

| Setting | Tipo | Valor |
| --- | --- | --- |
| `BASE_URL` | plain | `http://127.0.0.1:17322` |
| `SUMMARY_TOKEN` | secure | el token copiado desde Token Monitor |

CodexBar pedirá aprobar el origen normalizado `http://127.0.0.1:17322`. El manifest usa `https-or-private-network-http`, la política que CodexBar 0.55.1 exige cuando hay bearer sobre HTTP local; el provider comprueba además que `BASE_URL` sea exactamente ese loopback antes de iniciar ninguna petición. Este provider no lee `SUMMARY_TOKEN`: el host construye e inyecta `Authorization: Bearer …`. Cada petición usa un timeout físico de **2 s** y la ruta fija `/api/integrations/codexbar/v1/summary`.

## Modelo de seguridad

`SUMMARY_TOKEN` es un setting **secure** de CodexBar. Es un secreto distinto y separado tanto del secreto del Hub de Token Monitor como del bearer de la integración `dashboard-v1`; rotarlo no concede acceso a sincronización, límites ni otros endpoints.

El bridge escucha en `127.0.0.1` y solo admite tráfico local loopback. Requiere el bearer, rechaza `Origin`, no publica CORS, limita la respuesta a un allowlist de totales y frescura, y envía `Cache-Control: no-store`. Ni identidades, sesiones, proyectos, modelos, límites, rutas o secretos forman parte del resumen.

La lectura es cache-only: una petición de CodexBar no inicia ningún collector ni probe y no duplica la recolección propia de Token Monitor. La fila Actualizado conserva la marca absoluta `observedAt` en UTC y su edad, de modo que un snapshot last-good siempre comunica su frescura factual en vez de aparentar que acaba de recolectarse.

Los errores del plugin son acotados: no incluyen el body remoto, secretos, tokens ni trazas del servidor en logs o mensajes. El sandbox de CodexBar restringe además el provider al origen declarado; no dispone de Node, archivos locales, subprocesos, navegador ni timers.

## Gate E2E verificado

Última verificación: **2026-08-26**, macOS, CodexBar **0.55.1**. El mismo provider fue descubierto, pasó la aprobación tipada y se ejecutó correctamente con los motores **QuickJS** y **JavaScriptCore**. Ambos devolvieron únicamente las filas Hoy, Este mes y Actualizado. El bridge real respondió `200`, `Cache-Control: no-store` y sin CORS; la tarjeta se renderizó dentro del menú nativo.

La captura del README usa datos de muestra públicos para no publicar los totales o costes privados de ninguna cuenta. Se generó con la tarjeta nativa real, no con una recreación HTML. El gate con la caché real se validó por separado y no conserva el bearer ni sus cifras en el repositorio.

Comandos reproducibles, después de configurar el provider y su secret:

```bash
codexbar --version
codexbar plugins list
codexbar plugins fetch token-monitor-bridge --json --pretty
CODEXBAR_PLUGIN_ENGINE=quickjs codexbar plugins fetch token-monitor-bridge --json --pretty
CODEXBAR_PLUGIN_ENGINE=jsc codexbar plugins fetch token-monitor-bridge --json --pretty
```

La salida esperada contiene `details` con tres filas y `primary`, `secondary` y `tertiary` nulos. Nunca pegues `SUMMARY_TOKEN` en el comando: CodexBar lo obtiene de su setting secure y redacta sus volcados de configuración.

## Diagnóstico

| Síntoma | Significado | Acción |
| --- | --- | --- |
| `401` | `SUMMARY_TOKEN` ausente, antiguo o incorrecto | Vuelve a copiar el token desde Token Monitor y guárdalo como setting secure. |
| `403` | La petición incluyó un origen no permitido | Usa el provider local incluido en este fork, sin navegador ni proxy intermedio. |
| `404` | Token Monitor no expone la ruta exacta | Comprueba que ejecutas este fork y que el resumen está activado. No añadas `/` ni query a la ruta. |
| `503` | Todavía no existe un snapshot en memoria | Espera a la primera recolección normal de Token Monitor y pulsa Refresh en CodexBar. |
| Timeout a los 2 s | El proceso no escucha en el puerto configurado | Confirma que Token Monitor está abierto y que `BASE_URL` es `http://127.0.0.1:17322`. |

Si cambias `BASE_URL`, el modo de autenticación, los nombres o declaraciones de settings seguros del manifest, o sus capabilities, CodexBar invalida la aprobación anterior y solicita una nueva. Rotar solo el valor de `SUMMARY_TOKEN` no cambia la autoridad aprobada. Esto es comportamiento fail-closed del host.

## Dos direcciones, responsabilidades distintas

`CodexBar → Token Monitor` sigue usando `dashboard-v1` para aportar límites y cuotas de proveedores a Token Monitor. `Token Monitor → CodexBar` usa este plugin y el endpoint dedicado para presentar únicamente el resumen agregado. Son dos integraciones independientes, con credenciales, ciclos de refresco y esquemas separados; ninguna invoca a la otra.

La configuración de la primera dirección está en [CodexBar dashboard-v1 limits](configuration.md#codexbar-dashboard-v1-limits). La arquitectura, autoría y fronteras de distribución de ambas se resumen en el [README](../README.md).
