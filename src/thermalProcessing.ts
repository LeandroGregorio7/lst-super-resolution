// src/thermalProcessing.ts

/**
 * Simula a extração térmica reescalando os valores base para uma 
 * faixa de temperatura realista (ex: 22°C na água/sombra a 45°C no asfalto)
 * enquanto o módulo de co-registro Landsat/Sentinel é construído.
 */
export function calculateThermalRadiance(baseArray: Float32Array): {
  radiance: Float32Array;
  brightnessTempCelsius: Float32Array;
} {
  const totalPixels = baseArray.length;
  const radianceArray = new Float32Array(totalPixels);
  const tempCelsiusArray = new Float32Array(totalPixels);

  // 1. Descobrir os valores mínimos e máximos da imagem para calibrar
  let minVal = Infinity;
  let maxVal = -Infinity;
  for (let i = 0; i < totalPixels; i++) {
    const val = baseArray[i];
    if (val > 0) {
      if (val < minVal) minVal = val;
      if (val > maxVal) maxVal = val;
    }
  }

  // 2. Mapear os valores do satélite para Temperaturas Reais (°C)
  const tempMin = 22.0; // °C (Vegetação densa / Água)
  const tempMax = 45.0; // °C (Asfalto / Telhados quentes)
  const valRange = maxVal - minVal || 1;

  for (let i = 0; i < totalPixels; i++) {
    const val = baseArray[i];

    if (val <= 0) {
      radianceArray[i] = 0;
      tempCelsiusArray[i] = NaN; // Ignora píxeis sem dados
      continue;
    }

    // Normaliza de 0 a 1 e inverte (já que muita luz NIR/Red geralmente indica menos calor na proxy)
    let normalized = (val - minVal) / valRange;
    
    // Calcula a temperatura simulada
    const tempCelsius = tempMin + (normalized * (tempMax - tempMin));
    
    radianceArray[i] = val * 0.0003342; // Radiância simulada
    tempCelsiusArray[i] = tempCelsius;
  }

  return {
    radiance: radianceArray,
    brightnessTempCelsius: tempCelsiusArray
  };
}