import {
  boxVolume,
  regionVolume,
  buildBaseplateLuau,
  buildIslandLuau,
  buildMountainsLuau,
  buildWaterLuau,
  buildPaintMaterialLuau,
  buildClearRegionLuau,
} from '../builders/terrain-builders.js';

describe('volume helpers', () => {
  it('boxVolume multiplies the three dimensions', () => {
    expect(boxVolume([10, 2, 5])).toBe(100);
  });
  it('regionVolume uses absolute extents', () => {
    expect(regionVolume([-5, 0, -5], [5, 10, 5])).toBe(10 * 10 * 10);
  });
});

describe('buildBaseplateLuau', () => {
  it('fills a block of the requested size with the chosen material', () => {
    const code = buildBaseplateLuau({ size: [512, 8, 512], position: [0, 0, 0], material: 'Grass' });
    expect(code).toContain('workspace.Terrain');
    expect(code).toContain('FillBlock');
    expect(code).toContain('Vector3.new(512, 8, 512)');
    expect(code).toContain('Enum.Material.Grass');
  });
});

describe('buildIslandLuau', () => {
  it('fills a ball of land and returns a summary', () => {
    const code = buildIslandLuau({ center: [0, 0, 0], radius: 128, material: 'Sand' });
    expect(code).toContain('FillBall');
    expect(code).toContain('Enum.Material.Sand');
    expect(code).toContain('return');
  });
});

describe('buildMountainsLuau', () => {
  it('loops noise-driven columns of FillBlock', () => {
    const code = buildMountainsLuau({ center: [0, 0, 0], extent: [256, 256], maxHeight: 80, material: 'Rock' });
    expect(code).toContain('math.noise');
    expect(code).toContain('FillBlock');
    expect(code).toContain('Enum.Material.Rock');
  });
});

describe('buildWaterLuau', () => {
  it('fills a block with the Water material', () => {
    const code = buildWaterLuau({ size: [256, 16, 256], position: [0, -8, 0] });
    expect(code).toContain('Enum.Material.Water');
    expect(code).toContain('FillBlock');
  });
});

describe('buildPaintMaterialLuau', () => {
  it('fills a region with a material when no source material is given', () => {
    const code = buildPaintMaterialLuau({ min: [-50, 0, -50], max: [50, 20, 50], material: 'Slate' });
    expect(code).toContain('FillRegion');
    expect(code).toContain('Enum.Material.Slate');
  });
  it('uses ReplaceMaterial when a source material is given', () => {
    const code = buildPaintMaterialLuau({ min: [-50, 0, -50], max: [50, 20, 50], material: 'Slate', replaceMaterial: 'Grass' });
    expect(code).toContain('ReplaceMaterial');
    expect(code).toContain('Enum.Material.Grass');
    expect(code).toContain('Enum.Material.Slate');
  });
});

describe('buildClearRegionLuau', () => {
  it('fills the region with Air to clear it', () => {
    const code = buildClearRegionLuau({ min: [-50, 0, -50], max: [50, 20, 50] });
    expect(code).toContain('Enum.Material.Air');
    expect(code).toContain('FillRegion');
  });
});
