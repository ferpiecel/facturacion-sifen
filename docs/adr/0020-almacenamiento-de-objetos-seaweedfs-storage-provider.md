# ADR-0020: Almacenamiento de objetos con SeaweedFS detrás del puerto `StorageProvider`

- **Estado:** Propuesto
- **Fecha:** 2026-11-06

## Contexto

La recepción guarda el archivo original de cada documento (XML, PDF, foto) y debe servirlo de nuevo, por streaming o por URL prefirmada. La base de datos no debe contener objetos. El plan v1.1 (sección de infraestructura) lista "S3 / MinIO" como object storage; este ADR lo precisa para el MVP de recepción sin editar el texto aceptado del plan.

El proyecto hermano contahelper ya corre SeaweedFS con su API S3, pero sin identidades configuradas (acceso anónimo) y con la etiqueta `latest`. Ambas cosas son inaceptables para archivos fiscales de tenants.

## Decisión

1. **Puerto.** `StorageProvider` (`upload`, `download`, `delete`, `exists`, `presignedUrl`, `ping`) en `application/ports/`. El dominio y los casos de uso no conocen el proveedor. Es lo bastante genérico para alojar luego el KuDE.
2. **Adaptador.** `S3StorageProvider` con `@aws-sdk/client-s3` y `@aws-sdk/s3-request-presigner`, con `forcePathStyle: true`. Los SDK viven solo en `infrastructure/adapters/` (regla de depcruise que se agrega al crear el módulo).
3. **Backend.** SeaweedFS expuesto por su API S3, con imagen de etiqueta fija (nunca `latest`) y **identidades S3 configuradas**: el acceso anónimo debe ser rechazado. Las credenciales no se suben al repositorio; el archivo de identidades se genera desde una plantilla.
4. **URL prefirmadas.** La firma debe corresponder al host público: el servidor se levanta con `-s3.externalUrl` igual a `STORAGE_PUBLIC_ENDPOINT_URL`. Un test de integración obtiene la URL prefirmada por HTTP real y espera los bytes.
5. **Claves.** `<origen>/<tenant_id>/<sha256|cdc>.<ext>`, con prefijo de entorno y un bucket por entorno.
6. **Configuración fail-fast.** `STORAGE_ENDPOINT_URL`, `STORAGE_ACCESS_KEY_ID`, `STORAGE_SECRET_ACCESS_KEY`, `STORAGE_BUCKET`, `STORAGE_REGION`, `STORAGE_FORCE_PATH_STYLE` y `STORAGE_PUBLIC_ENDPOINT_URL`. Fuera de `development` y `test` la API no arranca sin ellas ni con valores permisivos. Se documentan en `docs/configuracion.md`.
7. **Retención.** Sin expiración por ahora: los artefactos se conservan indefinidos y no hay borrado. Según el dueño del producto, el mínimo legal de conservación es de 5 años (dato no verificado de forma independiente); cualquier política futura no podrá vencer artefactos antes de ese plazo.
8. **Pendiente de verificar en la implementación:** los nombres exactos de las banderas de SeaweedFS y el comportamiento de `externalUrl` contra la imagen elegida.

## Consecuencias

Una pieza más en el compose y en el CI (job con la imagen fija y test de URL prefirmada). Un nodo único limita la durabilidad: el respaldo y la replicación quedan como trabajo operativo. Cambiar de proveedor S3-compatible solo toca el adaptador y la configuración.

## Alternativas descartadas

- **MinIO:** el plan lo nombraba, pero se prefirió SeaweedFS por la experiencia previa en contahelper y para no depender de la evolución del licenciamiento y mantenimiento de la edición comunitaria de MinIO (a verificar al elegir la etiqueta).
- **Guardar los archivos en PostgreSQL (`bytea`):** infla la base, los respaldos y la memoria de las consultas.
- **Disco local del proceso:** no sirve con varias réplicas ni con workers.
- **SeaweedFS sin identidades (como contahelper):** acceso anónimo a documentos fiscales.
