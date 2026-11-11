Capturas reales anonimizadas del consulta-por-CDC de eKuatia, portadas
desde `contahelper` (`tests/fixtures/ekuatia/v2026-Q3/`) -- mismo proceso
de captura (`scripts/capture_ekuatia.py` + `scripts/anonymize_fixtures.py`
de ese repo). El XML (`documento.xml`) es el mismo que se usa en
`tests/fixtures/sifen/` de este repo; lo que aporta esto son
`requests.json`/`meta.json`, el registro de la conversacion HTTP real con
eKuatia -- lo unico que confirma el contrato que `EkuatiaClient` asume.
