# ADR-0022: Gateway SOAP por tenant con el certificado del tenant

- Estado: aceptado
- Relacionados: [ADR-0008](0008-sin-contingencia-cola-72h.md), [ADR-0009](0009-custodia-certificados-kms.md), [ADR-0010](0010-cada-tenant-es-facturador.md)

## Contexto

El adaptador SOAP existía pero no estaba conectado. Cada tenant es su propio facturador y SIFEN exige mTLS con su certificado.

## Decisión

- `SIFEN_GATEWAY=soap` crea un gateway por tenant (`TenantSoapGatewayFactory`). En cada llamada lee `tenants.environment`, abre el certificado por la caché de custodia (TTL corto, auditoría solo al descifrar, propósito `sifen-mtls`), lo convierte a PEM en memoria y abre una conexión nueva. Nada se guarda ni se registra.
- Los circuitos siguen siendo uno por endpoint y compartidos por todos los tenants (`CircuitBreakerGateway.around`).
- Una llamada que no puede empezar (sin certificado vigente, producción no habilitada) no envía nada y falla como `SifenCircuitOpenError` con `retryAt`: el trabajo queda diferido en cola, nunca `unknown`.
- Producción exige `SIFEN_SOAP_ALLOW_PRODUCTION=true` hasta validar el adaptador contra sifen-test.
- El simulador y sus guardas no cambian.

## Consecuencias

Se convierte el `.p12` en cada llamada (coste de CPU bajo, mínimo material en memoria). Un tenant con certificado vencido no afecta a los demás ni abre el circuito.
