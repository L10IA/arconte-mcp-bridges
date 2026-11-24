# ARCONTE MCP Bridges

Tres servidores MCP locales conectan Antigravity Desktop con Codex y Claude Code mediante sus CLI oficiales. Usan entrada y salida estándar y los módulos nativos de Node.js. Instala Node.js 24.14 o posterior y clona este repositorio. La delegación también requiere la CLI de destino instalada y autenticada.

| Servidor | Cliente habitual | Destino |
| --- | --- | --- |
| `codex-local` | Antigravity | Codex CLI |
| `claude-code-local` | Antigravity | Claude Code CLI |
| `antigravity-local` | Claude Code o Codex | Antigravity CLI y buzón opcional |

Sustituye `<PUENTES>` por la carpeta de este repositorio y `<PROYECTO>` por una carpeta absoluta, existente y local que quieras compartir. Los ejemplos JSON sirven para clientes con configuración `mcpServers`, como Antigravity. Cada ejemplo es una configuración completa independiente. Si el cliente ya tiene servidores, añade solo las entradas que necesites.

## 1. Comprobar la conexión

**Permite comprobar la conexión local.** Esta configuración solo ofrece `bridge_ping`. Llama a esa herramienta con `{}`. Devuelve `ARCONTE_OK` sin abrir una CLI, leer el proyecto ni consultar una cuenta.

```json
{
  "mcpServers": {
    "claude-code-local": { "command": "node", "args": ["<PUENTES>/claude-code-mcp-server.mjs"] }
  }
}
```

Para registrar el servidor de Antigravity en los otros dos clientes, ejecuta los siguientes comandos.

```powershell
codex mcp add antigravity-local -- node "<PUENTES>/antigravity-mcp-server.mjs"
claude mcp add -s user antigravity-local -- node "<PUENTES>/antigravity-mcp-server.mjs"
```

## 2. Delegar en un proyecto en solo lectura

**Permite consultar y revisar un proyecto.** Es la configuración recomendada para empezar a delegar. La raíz se fija en el arranque y `read-only` es el máximo predeterminado. Una llamada puede omitir `cwd` o seleccionar un subdirectorio real de esa raíz. El puente rechaza carpetas ajenas y solicitudes de escritura antes de iniciar una CLI.

```json
{
  "mcpServers": {
    "codex-local": { "command": "node", "args": ["<PUENTES>/codex-mcp-server.mjs", "--allow-project-data", "--project-root", "<PROYECTO>", "--access", "read-only"] },
    "claude-code-local": { "command": "node", "args": ["<PUENTES>/claude-code-mcp-server.mjs", "--allow-project-data", "--project-root", "<PROYECTO>", "--access", "read-only"] }
  }
}
```

Por ejemplo, llama a `codex_ask` con `{"prompt":"Resume los archivos de este proyecto de ejemplo."}`. Codex y Claude admiten revisión. Antigravity usa `antigravity_ask` en modo `plan`. Cada proveedor conserva sus mecanismos de autenticación y sus propios límites de acceso a archivos.

## 3. Habilitar escritura y coordinación

**Permite solicitar ediciones, enviar mensajes y archivar entregas con la identidad elegida.** La instancia sigue usando el modo de consulta predeterminado hasta que una llamada solicite expresamente una edición. El valor de `--mailbox-as` identifica al cliente remitente. En este ejemplo el cliente es Codex.

```json
{
  "mcpServers": {
    "antigravity-local": { "command": "node", "args": ["<PUENTES>/antigravity-mcp-server.mjs", "--allow-project-data", "--project-root", "<PROYECTO>", "--access", "read-write", "--mailbox-as", "codex"] }
  }
}
```

Codex y Claude Code aceptan los mismos argumentos de arranque tras el archivo del servidor. Para dar a Claude Code su propia bandeja, usa `--mailbox-as claude-code` en su registro. En `codex-local` y `claude-code-local`, la opción de escritura es `--access read-write`; la identidad de buzón solo está disponible en `antigravity-local`.

| Operación | Requisito |
| --- | --- |
| Consultar, revisar, listar o reanudar sesiones del proyecto | Delegación y raíz autorizada. Las sesiones deben haber sido registradas por este puente y proveedor para esa raíz. |
| Solicitar escritura de proyecto | `--access read-write` y la opción de la llamada: `workspace-write` en Codex, `edit` en Claude o `accept-edits` en Antigravity. |
| Consultar bandeja y archivo propios | Una identidad local entre `antigravity`, `claude-code` y `codex`. |
| Enviar a otro agente o archivar una entrega propia | Identidad local y `--access read-write`. El argumento opcional `de` debe coincidir con la identidad configurada. |

## Migrar desde la configuración anterior

Un registro con solo `--allow-project-data` ahora **falla en el arranque**. En los argumentos de arranque, sustituye la antigua opción aislada por `--allow-project-data --project-root "<PROYECTO>" --access read-only` como argumentos separados. Para volver a la comprobación básica, deja únicamente el archivo. Las opciones desconocidas, repetidas, incompletas o incompatibles detienen el servidor. Recarga la conexión MCP en el cliente. Las sesiones anteriores sin procedencia verificable y los mensajes del antiguo buzón global quedan fuera del nuevo ámbito. Inicia una sesión nueva en la raíz elegida. Para migrar una instancia con escritura, termina todos los escritores de la versión anterior y revisa sus cerrojos pendientes antes de activar la nueva rama. Todas las instancias que escriben sobre el mismo proyecto deben usar la misma raíz y el mismo almacén privado.

## Qué llega al proveedor

Un encargo delegado puede enviar el prompt, instrucciones del proyecto y contenido que lea la CLI al proveedor autenticado. El puente valida la carpeta inicial, los modos y la procedencia local de las sesiones. **El acceso a archivos depende de la CLI y de los permisos del sistema operativo.** Codex solicita su sandbox, Claude limita las herramientas de lectura a `Read, Grep, Glob` y Antigravity solicita planificación. La raíz admitida por el puente solo fija el directorio de trabajo. Consulta los detalles en [Seguridad y privacidad](SECURITY.md).

La aplicación de escritorio de Antigravity y su CLI tienen historiales distintos. El buzón coordina agentes del mismo proyecto en un equipo. El servidor MCP descarta mensajes mayores de 256 KiB y admite hasta cuatro herramientas simultáneas por proceso. Cuando una petición se rechaza por saturación, el cliente puede reintentar más tarde.

## Probar

Ejecuta `npm test`. La suite usa carpetas temporales, procesos Node para el transporte y dobles de las CLI. No necesita cuentas. [Licencia MIT](LICENSE).
