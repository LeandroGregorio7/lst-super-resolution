// src/stacSearch.ts

/**
 * Conecta na API STAC da Microsoft (Planetary Computer) e busca imagens Landsat
 */
export async function searchLandsatInCloud(targetDate: string) {
  console.log(`☁️ Iniciando conexão com a nuvem STAC (Microsoft Planetary Computer)...`);

  // 1. Cria uma janela de tempo (7 dias antes e 7 dias depois da imagem Sentinel)
  const date = new Date(targetDate);
  
  const start = new Date(date);
  start.setDate(date.getDate() - 7);
  
  const end = new Date(date);
  end.setDate(date.getDate() + 7);

  // Formata para o padrão que a API exige: YYYY-MM-DD/YYYY-MM-DD
  const timeString = `${start.toISOString().split('T')[0]}/${end.toISOString().split('T')[0]}`;
  console.log(`🔍 Buscando imagens térmicas no período: ${timeString}`);

  try {
    // 2. Faz a "pergunta" (POST request) para o servidor da Microsoft
    const response = await fetch("https://planetarycomputer.microsoft.com/api/stac/v1/search", {
      method: "POST",
      headers: { 
        "Content-Type": "application/json" 
      },
      body: JSON.stringify({
        collections: ["landsat-c2-l2"], // Busca a Coleção Landsat 8/9 Nível 2 (que tem a Banda Térmica)
        datetime: timeString,
        query: { 
          "eo:cloud_cover": { lt: 20 } // Filtra: Queremos imagens com Menos de 20% (< 20) de nuvem
        },
        limit: 5 // Traz no máximo os 5 melhores resultados
      })
    });

    // 3. Recebe a resposta e converte de volta para um objeto JavaScript
    const data = await response.json();
    
    if (data.features && data.features.length > 0) {
      console.log(`🛰️ SUCESSO! A nuvem respondeu e encontrou ${data.features.length} imagens do Landsat.`);
      console.log(`🔗 Link de download da Banda Térmica:`, data.features[0].assets.lwir11.href);
    } else {
      console.log(`⚠️ Poxa, o Landsat não tirou fotos sem nuvem nessa semana.`);
    }

    return data.features;

  } catch (error) {
    console.error("❌ Erro ao buscar na API STAC:", error);
    return null;
  }
}