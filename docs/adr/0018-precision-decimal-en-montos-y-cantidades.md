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
5. **Aritmética.** Sin `number` en el dominio para montos ni cantidades. La suma es exacta. El producto de precio por cantidad es exacto; si su resultado tiene más de 8 decimales la línea se rechaza, de modo que E727 y EA008 (igualdades en SIFEN) se cumplen sin redondeo. Las divisiones del IVA (base E735, liquidación E736) se redondean con un modo explícito: provisionalmente mitad hacia arriba a 8 decimales, a confirmar con el Prevalidador. Todo reescalado exige modo de redondeo explícito.
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
