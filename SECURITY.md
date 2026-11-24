# Seguridad y privacidad

## Autoridad local

Quien instala el puente selecciona la raíz de proyecto, el permiso máximo y la identidad del buzón al iniciar el proceso. Sin argumentos solo existe `bridge_ping`. Una configuración de delegación inválida impide el arranque. Las llamadas no pueden cambiar estas decisiones.

Antes de ejecutar una herramienta de proyecto, el puente valida la raíz y su identidad en el sistema de archivos. Comprueba los componentes, rechaza enlaces simbólicos y junctions, y compara rutas canónicas por componentes. En Windows también rechaza rutas UNC, rutas relativas a una unidad, rutas de dispositivo y nombres alternativos ambiguos. La raíz y sus subdirectorios deben pertenecer a un usuario de confianza. Otros procesos con permisos para sustituir archivos o carpetas entre la validación y la operación quedan fuera de esta garantía.

## Límites de las CLI

| CLI | Límite que aplica el puente | Acceso que todavía depende de la CLI o del equipo |
| --- | --- | --- |
| Codex | Pide sandbox `read-only` en consultas de lectura y revisiones. Solo admite `workspace-write` con autorización de arranque. | La sonda, configuraciones de proyecto o administradas y servidores MCP pueden tener acceso adicional. El sandbox no equivale a confinar las lecturas a la raíz. |
| Claude Code | Restringe herramientas en `read-only`, emplea los controles de planificación en `plan` y exige autorización para `edit`. | Instrucciones, ajustes de usuario o administrados, permisos del proceso y comportamiento de la versión instalada pueden ampliar el contexto leído. |
| Antigravity | Solicita `plan` en lectura. `accept-edits` requiere permiso de escritura. | El modo de planificación no es una frontera del sistema operativo. La CLI puede cargar sus plugins, MCP y ajustes. Su prompt viaja como argumento del proceso. |

La lista de variables de entorno entregadas a las CLI se limita a rutas del sistema, perfil, temporales e idioma. La CLI usa sus propias credenciales. Los filtros de contenido reconocen ciertos secretos, cabeceras de autorización, correos y rutas personales. Un documento confidencial puede parecer texto ordinario. Un archivo leído directamente por una CLI puede llegar al proveedor sin pasar por esos filtros. Comparte únicamente proyectos autorizados para ese destino.

## Sesiones, buzón y acceso directo

- El puente registra identificadores de sesiones exitosas por proveedor y raíz canónica en un almacén privado del usuario fuera del proyecto. En Windows usa `%LOCALAPPDATA%/ARCONTE/mcp-state`. En otros sistemas usa el estado del usuario bajo `~/.local/state/ARCONTE/mcp-state` cuando no hay `LOCALAPPDATA`. Las marcas no contienen prompts ni respuestas. La CLI y el cliente pueden conservar sus propios historiales.
- El listado de conversaciones usa esas marcas locales. La reanudación exige una marca del mismo proyecto y proveedor, incluso si el cliente proporciona un UUID válido. Los archivos de sesiones antiguos de la CLI no acreditan esa procedencia. La comprobación se refiere al proyecto autorizado, que puede incluir varios subdirectorios.
- El buzón se organiza por proyecto, con bandejas y archivos por destinatario. La identidad de arranque determina quién envía y quién puede consultar o archivar una entrega. Omite `--mailbox-as` para desactivar el buzón. Las instancias de un proyecto deben compartir el mismo almacén. Puedes indicar una base local con `ARCONTE_BUZON_DIR`, fuera del proyecto.
- Los mensajes se guardan en texto local, con un asunto abreviado en el nombre del archivo. Las ACL del sistema operativo protegen el estado de sesiones y el buzón. Procesos con acceso directo a estas carpetas pueden leerlas o alterarlas. No uses directorios compartidos con usuarios o procesos no confiables.

## Disponibilidad y errores

Cada trama JSON-RPC admite 262 144 bytes antes del LF, incluidos sus espacios y cualquier CR. El servidor descarta el exceso al recibirlo, responde una vez y vuelve a sincronizarse en el siguiente LF. Usa el código `-32001` con identificador nulo para tramas demasiado grandes y `-32002` para saturación. Admite cuatro llamadas de herramienta simultáneas por proceso. Los límites no sustituyen las cuotas del sistema ni las del proveedor.

Los errores al cliente usan diagnósticos del puente. Ante un bloqueo de escritura pendiente, comprueba localmente si siguen activos la CLI o sus descendientes antes de retirar el cerrojo del directorio temporal de ARCONTE. En POSIX, terminar el hijo directo deja el árbol sin confirmar. El aviso MCP omite la ruta del cerrojo y el contenido de stderr.

Para informar de un problema, describe la versión, la condición previa y el efecto con un ejemplo ficticio. Conserva en privado las credenciales, rutas personales, historiales y registros reales.
