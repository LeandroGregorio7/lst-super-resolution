// src/exportTiff.ts

/**
 * 🚀 Exporta GeoTIFF usando um layout de memória estático à prova de falhas.
 */
export async function downloadFloat32Tiff(
  data: Float32Array, width: number, height: number, filename: string,
  origin: number[], resolution: number[], epsg: number, isProjected: boolean
) {
  try {
    // Cálculo exato e estático dos bytes (14 tags = 288 bytes de Header)
    const fileSize = 288 + (data.length * 4);
    const buffer = new ArrayBuffer(fileSize);
    const view = new DataView(buffer);

    // 1. Header Principal TIFF
    view.setUint16(0, 0x4949, false); // "II" Little Endian
    view.setUint16(2, 42, true);      // Magic Number
    view.setUint32(4, 8, true);       // IFD Offset

    // 2. Número de Tags (14)
    view.setUint16(8, 14, true);
    let offset = 10;

    const addTag = (tag: number, type: number, count: number, val: number) => {
      view.setUint16(offset, tag, true);
      view.setUint16(offset + 2, type, true);
      view.setUint32(offset + 4, count, true);
      if (type === 3 && count === 1) { view.setUint16(offset + 8, val, true); view.setUint16(offset + 10, 0, true); } 
      else { view.setUint32(offset + 8, val, true); }
      offset += 12;
    };

    // Escrever as Tags Base
    addTag(256, 4, 1, width);
    addTag(257, 4, 1, height);
    addTag(258, 3, 1, 32);
    addTag(259, 3, 1, 1);
    addTag(262, 3, 1, 1);
    addTag(273, 4, 1, 288); // Onde começam os dados de imagem (Pixel Offset)
    addTag(277, 3, 1, 1);
    addTag(278, 4, 1, height);
    addTag(279, 4, 1, data.byteLength);
    addTag(284, 3, 1, 1);
    addTag(339, 3, 1, 3);
    
    // Tags Geográficas apontando para espaços fixos na memória
    addTag(33550, 12, 3, 184); // ModelPixelScaleOffset
    addTag(33922, 12, 6, 208); // ModelTiepointOffset
    addTag(34735, 3, 16, 256); // GeoKeyDirectoryOffset

    view.setUint32(offset, 0, true); // Fim do IFD

    // 3. Escrever ModelPixelScale (Resolução) - Posição 184
    view.setFloat64(184, Math.abs(resolution[0]), true);
    view.setFloat64(192, Math.abs(resolution[1]), true);
    view.setFloat64(200, 0.0, true);

    // 4. Escrever ModelTiepoint (Origem) - Posição 208
    view.setFloat64(208, 0, true); view.setFloat64(216, 0, true); view.setFloat64(224, 0, true);
    view.setFloat64(232, origin[0], true); view.setFloat64(240, origin[1], true); view.setFloat64(248, 0, true);

    // 5. Escrever GeoKeyDirectory (EPSG) - Posição 256
    const setKey = (addr: number, k1: number, k2: number, k3: number, k4: number) => {
      view.setUint16(addr, k1, true); view.setUint16(addr + 2, k2, true);
      view.setUint16(addr + 4, k3, true); view.setUint16(addr + 6, k4, true);
    };

    setKey(256, 1, 1, 0, 3); // Header
    if (isProjected) {
      setKey(264, 1024, 0, 1, 1); // Projected Coordinate System
      setKey(272, 1025, 0, 1, 1); // Pixel is Area
      setKey(280, 3072, 0, 1, epsg); // ProjectedCSType = EPSG
    } else {
      setKey(264, 1024, 0, 1, 2); // Geographic Coordinate System
      setKey(272, 1025, 0, 1, 1); // Pixel is Area
      setKey(280, 2048, 0, 1, epsg); // GeographicType = EPSG
    }

    // 6. Escrever Matriz Térmica (Posição 288)
    const floatView = new Float32Array(buffer, 288);
    floatView.set(data);

    // 7. Forçar Download
    const blob = new Blob([buffer], { type: "image/tiff" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = filename; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  } catch (error) {
    console.error("Erro ao gerar GeoTIFF:", error);
    alert("Erro ao exportar GeoTIFF. Verifique o console.");
  }
}

export async function downloadUhiTiff(
  data: Float32Array, width: number, height: number, filename: string,
  origin: number[], resolution: number[], epsg: number, isProjected: boolean,
  mean: number = 0, stdDev: number = 1
) {
  const uhiData = new Float32Array(data.length);
  for (let i = 0; i < data.length; i++) {
    const val = data[i];
    if (isNaN(val) || !isFinite(val) || val <= 0) uhiData[i] = 0;
    else if (val < mean) uhiData[i] = 1;
    else if (val < mean + 0.5 * stdDev) uhiData[i] = 2;
    else if (val < mean + 1.5 * stdDev) uhiData[i] = 3;
    else uhiData[i] = 4;
  }
  await downloadFloat32Tiff(uhiData, width, height, filename, origin, resolution, epsg, isProjected);
}