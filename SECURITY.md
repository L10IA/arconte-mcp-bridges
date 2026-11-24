# Seguridad y privacidad

## Elegir qué se comparte

Con la configuración inicial, cada servidor solo contesta a `bridge_ping` con un resultado fijo. La llamada acepta un objeto vacío. No inicia la CLI del proveedor ni consulta cuentas, archivos, sesiones o mensajes.

El operador puede activar la delegación añadiendo `--allow-project-data` al comando de arranque local. Al hacerlo, el cliente de origen ya conoce los argumentos de la llamada y la CLI de destino puede enviar el encargo, sus instrucciones y el contenido que lea a su proveedor. Usa únicamente una carpeta y un encargo cuyo contenido esté autorizado para ese destino. El modo de solo lectura limita las escrituras. Los ajustes, herramientas y permisos de la CLI determinan qué información puede leer.

Los puentes bloquean patrones reconocibles de claves, cabeceras de autorización, correos y rutas personales en los campos de contenido y en las respuestas. Una lista de clientes, una negociación o un documento médico pueden parecer texto corriente. Los archivos leídos directamente por una CLI tampoco atraviesan el filtro del puente. Para trabajos con esos datos, conserva el modo de conexión.

## Qué queda en el equipo

En delegación, el cliente elige cualquier carpeta local válida. Los servidores no vinculan las sesiones reanudadas con el proyecto que las creó. Un cliente que conoce un identificador puede solicitar contexto de otro proyecto del mismo usuario. Reserva este modo para clientes, proyectos, agentes y configuraciones de confianza. En sistemas POSIX, un escritor que agote el tiempo conserva su cerrojo hasta que un operador compruebe que terminaron todos los procesos.

- Los servidores hablan JSON-RPC por entrada y salida estándar. Las aplicaciones cliente y las CLI pueden conservar su propio historial.
- Las CLI usan sus credenciales locales. El puente les entrega solo ciertas variables del sistema, como el perfil y el directorio temporal. Las respuestas de estado omiten la ruta del ejecutable, el plan y los datos de cuenta. Los errores del proveedor y sus registros de diagnóstico se mantienen fuera de las respuestas MCP.
- En delegación, `cwd` es una ruta local necesaria para seleccionar el proyecto. Codex y Claude reciben el encargo por entrada estándar. Antigravity lo recibe como argumento del proceso, visible para usuarios con permisos para inspeccionarlo.
- El buzón de delegación guarda texto en archivos locales. Otros procesos que tengan acceso a esa carpeta pueden leerlo o modificarlo. Los identificadores de mensajes incluyen el asunto. Usa asuntos genéricos y concede acceso al buzón únicamente a personas y procesos de confianza.
- Mantén los archivos de configuración de tus clientes, historiales, mensajes, credenciales y registros fuera del repositorio. Los ejemplos solo necesitan rutas de sustitución. Al actualizar, vuelve a conectar los servidores ya iniciados para cargar el código nuevo.

Si informas de un problema de seguridad, incluye el comportamiento observado y un ejemplo inventado. Omite credenciales, mensajes de buzón, identificadores de cuenta y registros de sesiones reales.
