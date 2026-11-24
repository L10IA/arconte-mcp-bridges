# ARCONTE MCP Bridges

Conecta Antigravity Desktop, Codex y Claude Code mediante tres servidores locales del Model Context Protocol (MCP). Cada servidor usa entrada y salida estándar. El código funciona con Node.js 24.14 o posterior y usa solo módulos de Node. La integración con las CLI se ha probado en Windows.

| Desde | Servidor | Destino en modo de delegación |
| --- | --- | --- |
| Antigravity Desktop | `codex-local` | Codex CLI |
| Antigravity Desktop | `claude-code-local` | Claude Code CLI |
| Codex o Claude Code | `antigravity-local` | Antigravity CLI y buzón local de coordinación |

## Primera conexión

Clona este repositorio y registra el archivo del servidor en el cliente de origen. Cada usuario necesita su instalación local de Node. Para delegar tareas también necesita la CLI oficial de destino y una sesión iniciada con ese proveedor.

En Antigravity, añade estas entradas a `mcpServers` de su configuración MCP. Sustituye los marcadores por rutas absolutas locales.

```json
{
  "mcpServers": {
    "codex-local": {
      "command": "<NODE>",
      "args": ["<DIRECTORIO>/codex-mcp-server.mjs"]
    },
    "claude-code-local": {
      "command": "<NODE>",
      "args": ["<DIRECTORIO>/claude-code-mcp-server.mjs"]
    }
  }
}
```

En Codex o Claude Code puedes registrar Antigravity desde su respectiva CLI.

```powershell
codex mcp add antigravity-local -- "<NODE>" "<DIRECTORIO>/antigravity-mcp-server.mjs"
claude mcp add -s user antigravity-local -- "<NODE>" "<DIRECTORIO>/antigravity-mcp-server.mjs"
```

Recarga el servidor en el cliente, abre su lista de herramientas y llama a `bridge_ping` con `{}`. La respuesta esperada es **ARCONTE_OK**. En este modo el puente comprueba el transporte MCP local. El proveedor no recibe ninguna consulta.

## Delegación de proyectos

Para habilitar las herramientas de trabajo, añade `--allow-project-data` como único argumento después del archivo `.mjs` y vuelve a conectar el servidor. Por ejemplo, `"args": ["<DIRECTORIO>/claude-code-mcp-server.mjs", "--allow-project-data"]`.

| Servidor | Herramientas disponibles al habilitar delegación |
| --- | --- |
| Codex | `codex_status`, `codex_models`, `codex_ask`, `codex_review` |
| Claude Code | `claude_status`, `claude_ask`, `claude_review`, `claude_list_sessions` |
| Antigravity | `antigravity_status`, `antigravity_models`, `antigravity_ask`, `antigravity_list_conversations`, `buzon_list`, `buzon_read`, `buzon_send`, `buzon_archive` |

Las consultas y revisiones se ejecutan en la carpeta indicada por `cwd`. La CLI de destino puede leer archivos de esa carpeta y enviar contexto al proveedor. Una sesión reanudada también puede incluir datos de turnos anteriores. Para regresar al modo de conexión, quita el argumento y recarga el servidor. Consulta [Seguridad y privacidad](SECURITY.md).

La integración de Antigravity usa su CLI oficial, con un historial distinto al de las conversaciones abiertas en Desktop. Para usar el buzón, crea una carpeta local, limita su acceso y configura `ARCONTE_BUZON_DIR` para el servidor `antigravity-local`. El buzón persiste mensajes en texto en ese equipo.

## Pruebas

```sh
npm test
```

La suite usa archivos temporales, dobles de las CLI y mensajes ficticios. Incluye pruebas del transporte stdio real, validación de rutas, concurrencia y privacidad. Puede ejecutarse sin cuentas de los proveedores.

El proyecto se distribuye con la [licencia MIT](LICENSE).
