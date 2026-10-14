# ADR-0018: Precisión decimal exacta en montos y cantidades

- **Estado:** Aceptado (las reglas de redondeo del IVA quedan provisionales hasta confirmarlas con el Prevalidador, T1)
- **Fecha:** 2026-10-13

## Contexto

La plataforma rechaza todo `unitPrice` o `quantity × unitPrice` que no sea entero (regla `pyg-integer` de `invoice-draft.ts`). Esa suposición nace de la primera validación del repositorio y no figura en el Manual Técnico v150 ni en las notas técnicas. Además los montos se calculan con `number`: `2.3 * 100` da `229.99999999999997`, de modo que una línea válida se rechaza y el mismo producto alimenta el total del documento.

El Manual y las notas permiten decimales: los montos admiten hasta 15 dígitos enteros y 8 decimales, la cantidad admite hasta 10 enteros y 8 decimales (NT 023, sección 1.2, que amplía los 4 decimales del Manual) y el XSD vendorizado lo confirma (`tMontoBase` 23 dígitos con 8 decimales; `tdCantProSer` 18 con 8). Las validaciones aritméticas de SIFEN son igualdades, sin tolerancia declarada para montos (hallazgos de T0 en `odd/tasks/decimal-precision.md`). La base de datos ya guarda `numeric(23,8)`. El constructor de TIPS calcula con `number` y `toFixed`, y con su configuración por defecto redondea los totales de ítem a entero en PYG.

## Decisión

1. **Representación.** Un value object de dominio `Decimal` sobre enteros `BigInt` con escala fija de 8 decimales. Sin dependencia nueva, exacto y suficiente para 15 + 8 dígitos. Es TypeScript puro, sin decoradores ni imports de framework (ADR-0003).
2. **Formato de entrada.** `unitPrice`, `quantity` y `roundingPyg` siguen aceptando un número JSON y además aceptan una cadena decimal (`"2.3"`, sin exponente). Las cadenas permiten valores exactos más allá de 15 cifras significativas. Es compatible hacia atrás.
3. **Números JSON.** Un número se convierte por su representación decimal más corta (`String(n)`); si tiene más de 15 cifras significativas se rechaza, porque ya perdió información al parsearse como binario.
4. **Límites.** `unitPrice` hasta 15 enteros y 8 decimales; `quantity` hasta 10 enteros y 8 decimales; ambos no negativos; `roundingPyg` entero de 0 a 49 por ahora. Un valor fuera de límite da `422` con el nombre de la regla.
5. **Aritmética.** Sin `number` en el dominio para montos ni cantidades. La suma es exacta. El producto de precio por cantidad es exacto; si su resultado tiene más de 8 decimales la línea se rechaza, de modo que E727 y EA008 (igualdades en SIFEN) se cumplen sin redondeo. **Provisional hasta T1:** el Manual no declara tolerancia para E727/EA008 y las trata como igualdades, pero su nota del grupo F dice que "para monedas extranjeras o cualquier otro cálculo que contenga decimales, las reglas de validación aceptarán redondeos de 50 céntimos (por encima o por debajo)"; no aclara si aplica a PYG con decimales, y solo el Prevalidador lo puede confirmar. Las divisiones del IVA (base E735, liquidación E736) se redondean con un modo explícito: provisionalmente mitad hacia arriba a 8 decimales, a confirmar con el Prevalidador. Todo reescalado exige modo de redondeo explícito.
6. **Redondeo de PYG.** Sin cambios: el total se redondea hacia abajo a un múltiplo de 50 Gs (Manual, grupo F). Los documentos aceptados hoy producen el mismo XML, totales y KuDE.
7. **Salida.** Las cadenas de monto son decimales planos, sin exponente y sin ceros finales innecesarios, para que el XML y el KuDE enteros no cambien.
8. **TIPS.** El adaptador de emisión debe pasar la configuración de decimales de `xmlgen` (`pygDecimals`, `pygTaxDecimals`) para que no redondee a entero los totales de ítem con decimales (T5).

Moneda extranjera, tipo de cambio, redondeo de 50 céntimos y descuentos quedan fuera; los cubrirá una funcionalidad `multi-currency`.

## Consecuencias

Se aceptan precios y cantidades decimales con exactitud y se evita el rechazo falso de líneas válidas. El dominio gana un tipo propio con pruebas de límites. Los puntos abiertos (modo de redondeo del IVA, subtotales PYG con decimales, `dRedon` fraccionario) deben cerrarse con evidencia del Prevalidador antes de codificar T4; si la evidencia contradice la decisión 5, se enmienda este ADR. El contrato de la API, la documentación y el KuDE cambian en tareas posteriores (T4 a T8).

## Alternativas descartadas

- **`decimal.js` o `big.js`**: dependencia nueva para un caso acotado (suma, producto y comparación con escala fija); `BigInt` lo cubre sin dependencias.
- **Seguir con `number` y tolerancias (`Math.round(x * 1e8) / 1e8`)**: oculta el error binario en vez de eliminarlo y falla fuera del rango seguro de 15 cifras.
- **Aceptar solo cadenas decimales**: rompe a los integradores que envían números JSON.
- **Mantener la regla de enteros en PYG**: rechaza documentos que SIFEN admite.

## Enmienda (HU-E5-09, T4 y T5): redondeo fraccionario, opción de activación y contrato del XML

- **`roundingPyg` (decisión 4).** Con los decimales habilitados, `roundingPyg` admite hasta 4 decimales (de 0 a 49,9999, el formato de `dRedon`, F013) y el total menos el redondeo debe ser múltiplo de 50 Gs. Con un redondeo solo entero, un total como 0,5 × 1001 = 500,5 nunca podría ser múltiplo de 50. Con los decimales deshabilitados el redondeo sigue siendo entero de 0 a 49.
- **Activación.** `ValidationConfig.allowDecimals` está apagada por defecto, de modo que los documentos aceptados hoy conservan el mismo XML, totales y KuDE. Se enciende en un paso explícito aparte, una vez que el Prevalidador confirme los puntos abiertos de T1. La misma configuración se pasa a `generateInvoiceXml` (y por `SignDocument` al worker) para que el worker no rechace lo que la API aceptó.
- **XML de un documento con decimales** (solo cuando algún total de línea o el redondeo tiene decimales; los demás, incluidos los de cantidad decimal con total entero, siguen con la configuración por defecto de `xmlgen`): se pasan a `xmlgen` `pygDecimals: 8`, `pygTaxDecimals: 8` y `redondeoSedeco: false`; `dRedon` y `dTotGralOpe` se fijan después con los totales validados, porque el redondeo SEDECO de `xmlgen` solo entiende enteros; los precios y cantidades no enteros viajan como cadenas decimales planas y cualquier número con exponente (`1e-7`) se reescribe como decimal plano. El XML se valida contra el XSD vigente y el QR sale del XML firmado.
- **Provisional hasta T1.** Con `pygTaxDecimals: 8`, los subtotales y las sumas de IVA y base de estos documentos conservan 8 decimales (las igualdades de las validaciones se cumplen por construcción), a diferencia de los documentos enteros, donde `xmlgen` los redondea a entero. Falta confirmar con el Prevalidador cuál de las dos formas acepta SIFEN para PYG con decimales.
