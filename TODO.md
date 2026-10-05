# Entregas da aplicação SR2D4 LST Explorer

- Remover completamente o acoplamento ao sistema de plugins, contratos, manifests e wrappers GeoLibre; a aplicação deve iniciar como site próprio.
- Criar uma home profissional e responsiva com mapa principal, marca SR2D4 / LST Explorer, estado do projeto e botão para o notebook Colab.
- Implementar mapa-base configurável com MapLibre GL JS, OSM padrão e opções Esri/Carto quando configuradas.
- Implementar upload local de GeoTIFF, leitura de metadata, seleção Red/NIR/SWIR e cálculo da LST no navegador.
- Implementar camadas óptica/LST, transparência, contraste, paletas, legenda automática em °C e controle de visibilidade.
- Implementar inspeção de temperatura por clique, estatísticas mínima/máxima/média/desvio, histograma e análise UHI.
- Implementar comparação antes/depois, desenho de AOI, recorte da área selecionada e exportação PNG/GeoTIFF.
- Implementar metadados do raster, suporte PT/EN, tema claro/escuro, ajuda/metodologia e explicação das limitações.
- Configurar workflow GitHub Actions para build e publicação no GitHub Pages.
- Validar com typecheck, lint, build e teste local do bundle publicado.
