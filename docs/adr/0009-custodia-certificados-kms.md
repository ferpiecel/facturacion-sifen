# ADR-0009: Custodia de certificados con envelope encryption

- **Estado:** Aceptado
- **Fecha:** 2026-09-22

## Contexto
Cada tenant entrega un `.p12` con su clave privada. Una fuga compromete su firma ante la DNIT.

## Decisión
Envelope encryption: una data key generada por KMS (o Vault Transit) cifra el `.p12` con AES-256-GCM. El texto cifrado va a object storage y la referencia a la clave, a Postgres. Se descifra en memoria al firmar, con caché LRU de TTL corto. Nunca se escribe a disco, a logs ni a respuestas. Los CSC se tratan igual.

## Consecuencias
Hay una dependencia de KMS en la ruta de firma. Todo acceso a la clave queda auditado.

## Alternativas descartadas
Guardar el `.p12` cifrado con una clave de la aplicación (si se filtra esa clave, se filtran todos).
