# Captura y anonimización de eKuatia (R6.4)

Herramientas para que **una persona** capture una consulta real a eKuatia y la convierta en fixture. Ningún agente ni el CI las ejecuta: `capture-ekuatia.ts` se niega a correr si `CI` está definida o si falta `--i-am-a-human`.

## Para qué sirve

Las capturas ya versionadas (`apps/api/test/fixtures/reception/ekuatia/v2026-Q3/*/requests.json`) guardan solo las **respuestas**. Esta captura registra también la **petición** y debe resolver tres dudas que ADR-0027 deja sin verificar:

| #   | Duda                                                         | Dónde se lee en `requests.json`                                                                                          |
| --- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| 1   | Cuerpo y cabeceras del `POST /docs/documento-electronico`    | `[0].request.headers` y `[0].request.body` (token redactado) junto con `[0].status_code`                                 |
| 2   | Cómo se manifiesta un captcha rechazado y un CDC inexistente | Corrida con `--probe-rejected-captcha` (captcha) y corrida con un CDC bien formado pero inexistente                      |
| 3   | Si el sitio exige reenviar las cookies                       | El segundo registro (`GET` sin cookies) frente al tercero (`GET` con las cookies del `POST`), más `request.cookie_names` |

Limitaciones a tener presentes: las cabeceras que Node agrega solo (`user-agent`, `accept-encoding`, `host`) no son observables y no quedan registradas. El `POST` replica la convención de las implementaciones de referencia (`{"cdc", "captcha"}`): que eKuatia lo acepte confirma que **funciona**, no que sea lo que envía el navegador; para eso conviene comparar con la pestaña Network de las herramientas del navegador. El `GET` sin cookies va primero: si eKuatia invalida algo tras el primer acceso, el `GET` con cookies podría fallar por otra causa.

## Advertencias

- **Cuesta dinero.** Cada corrida normal resuelve un captcha en 2Captcha (unos centavos). No la pongas en un bucle. El modo `--probe-rejected-captcha` no gasta nada.
- **Términos de uso.** La consulta pública de eKuatia y 2Captcha tienen sus propios términos; quien corre la captura (el dueño del producto, ADR-0027) los asume.
- **Credenciales.** La clave de 2Captcha se lee **solo** de la variable de entorno `TWOCAPTCHA_API_KEY`, después de pasar el resto de las guardas. Nunca de `.env`, nunca se imprime ni se escribe a disco; el token del captcha y la clave se redactan en todo lo que se guarda.
- **Datos reales.** La salida cruda contiene un documento real. Vive en `.captures/` (ignorado por git) y **no se commitea**; antes pasa por el anonimizador.

## Procedimiento

Desde la raíz del repositorio, con Node 22 (`nvm use`):

1. Exportá la clave en tu terminal (no la pegues en archivos):

   ```bash
   export TWOCAPTCHA_API_KEY=...
   ```

2. Capturá un CDC real que puedas consultar (44 dígitos). El script imprime a qué hosts llama y pide confirmación (`--yes` la omite):

   ```bash
   pnpm --filter @sifen/api capture:ekuatia -- --i-am-a-human --cdc <44 dígitos> --label success
   ```

   Salida en `apps/api/.captures/<vYYYY-Qn>/<label>/` con `requests.json`, `meta.json` y, si eKuatia lo devolvió, `documento.xml`. Cada registro de `requests.json` incluye el lado petición (`request`).

3. Opcional, sin costo, para la duda 2 (captcha rechazado). No usa 2Captcha ni necesita la clave:

   ```bash
   pnpm --filter @sifen/api capture:ekuatia -- --i-am-a-human --probe-rejected-captcha --cdc <44 dígitos> --label captcha_rejected
   ```

4. Opcional, con costo, para la duda 2 (CDC inexistente): repetí el paso 2 con un CDC de 44 dígitos bien formado que no exista y `--label not_found`.

5. Anonimizá cada captura que quieras conservar (trabaja solo con archivos locales):

   ```bash
   pnpm --filter @sifen/api anonymize:ekuatia -- --in .captures/<vYYYY-Qn>/success --out <directorio de salida>
   ```

   Reemplaza RUC (con su dígito verificador), CDC (sintético con dígito verificador válido, el mismo CDC original siempre da el mismo sintético dentro de la corrida), razón social, direcciones, teléfonos, correos, hashes del QR y la firma XML, y quita cookies y cabeceras de sesión. Escribe `anonymization-report.json` con los conteos por categoría, sin valores originales.

6. **Revisá a mano** el resultado: los nombres en texto libre fuera de los campos conocidos no se detectan automáticamente. Buscá nombres de personas o empresas, códigos de cliente y teléfonos.

7. Copiá el resultado a `apps/api/test/fixtures/reception/ekuatia/vYYYY-Qn/<label>/` y actualizá `fixtures.manifest.json` como indica `apps/api/test/fixtures/reception/README.md` (regenerar el manifiesto con los nuevos bytes). Para regenerarlo, guardá este script como `gen.mjs` fuera del repositorio y ejecutá `node gen.mjs > fixtures.manifest.json` dentro de `apps/api/test/fixtures/reception/`:

   ```js
   import { createHash } from 'node:crypto';
   import { readdirSync, readFileSync, statSync } from 'node:fs';
   import { join, relative } from 'node:path';
   const walk = (d) =>
     readdirSync(d).flatMap((n) => {
       const f = join(d, n);
       return statSync(f).isDirectory() ? walk(f) : [f];
     });
   const out = {};
   for (const f of ['sifen', 'ekuatia']
     .flatMap(walk)
     .map((f) => relative('.', f))
     .sort()) {
     out[f] = createHash('sha256').update(readFileSync(f)).digest('hex');
   }
   process.stdout.write(JSON.stringify(out, null, 2) + '\n');
   ```

   Verificá con `pnpm --filter @sifen/api exec vitest run test/fixtures/reception` y actualizá la procedencia en el README de fixtures (fecha y origen de la captura).

8. Con las dudas resueltas, enmendá ADR-0027 (no se edita un ADR aceptado) y ajustá `EkuatiaHttpClient` si el contrato real difiere.

## Cómo está armado

| Archivo                 | Rol                                                                                                                    |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `capture-core.ts`       | Lógica pura e inyectable: guardas, redacción, registro de petición/respuesta, la consulta (recibe `fetch` y el solver) |
| `capture-ekuatia.ts`    | Entrypoint: guardas, resumen de costo, confirmación, escritura de archivos                                             |
| `anonymize-fixtures.ts` | Anonimizador, escáner de datos sensibles (`scanSensitive`) y CLI                                                       |

- Los scripts se compilan con `tsconfig.scripts.json` a `dist/scripts-build/` (no hay `tsx` en el repositorio, y la compilación con `tsc` es el mecanismo que ya usan `ops` y `worker`). Ningún código de `src/` los importa; `depcruise` solo cubre `src/`.
- `tsconfig.json` los incluye, así que `typecheck` y `eslint` los cubren. Sus tests (`*.spec.ts`, sin red: dobles en memoria) corren con `vitest`.
- La cobertura de 85 % solo mide `src/**`: estos archivos quedan fuera del gate, pero su lógica pura tiene tests propios.
- El anonimizador es idempotente a nivel de captura: su `meta.json` lleva `anonymized: true` y una captura así se devuelve sin cambios.

## Límites conocidos

- Los RUC sintéticos del anonimizador (`80000000` en adelante, ver `scanSensitive`) caen dentro del espacio de RUC reales: son datos de prueba, no se pueden distinguir con certeza de un RUC existente.
- `--label` solo admite letras, dígitos, `_` y `-`. El directorio de salida se crea y se comprueba como escribible antes de resolver el captcha.
- El anonimizador solo reescribe las claves JSON que conoce: nombres o direcciones bajo claves desconocidas pasan sin cambios (de ahí la revisión manual).
- Un argumento desconocido se imprime tal cual en el mensaje de error de la CLI.
- Las cabeceras que `fetch` agrega por su cuenta no quedan registradas.
- El directorio de salida se crea después de la comprobación de escritura y antes de la confirmación interactiva.
