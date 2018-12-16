const path = require('path');
const config = require('config');
const { cpus } = require('os');
const { stat } = require('fs').promises;
const dirtyTiles = require('./dirtyTilesRegister');
const { tile2key } = require('./tileCalc');
const renderTile = require('./renderrer');
const { tileRangeGenerator } = require('./tileCalc');

const rerenderOlderThanMs = config.get('rerenderOlderThanMs');

module.exports = {
  prerender,
  fillDirtyTilesRegister,
  resume,
};

const prerenderConfig = config.get('prerender');
const tilesDir = path.resolve(__dirname, '..', config.get('dirs.tiles'));

const resumes = new Set();

function resume() {
  console.log('Resuming pre-rendering.', dirtyTiles.size);

  for (const rf of resumes) {
    rf();
  }
  resumes.clear();
}

async function prerender(pool) {
  console.log('Starting pre-renderrer.');

  const tiles = findTilesToRender();

  await Promise.all(Array(prerenderConfig.workers || cpus().length).fill(0)
    .map(() => worker(pool, tiles)));

  throw new Error('unexpected');
}

async function* findTilesToRender() {
  const { zoomPrio } = prerenderConfig;
  let restart = false;
  function setRestartFlag() {
    restart = true;
  }

  main: for (;;) {
    resumes.add(setRestartFlag);

    const tiles = [...dirtyTiles.values()].sort((a, b) => {
      const c = zoomPrio.indexOf(a.zoom);
      const d = zoomPrio.indexOf(b.zoom);
      return c === d ? b.ts - a.ts : c - d;
    });

    for (const t of tiles) {
      if (restart) {
        restart = false;
        continue main;
      }
      yield t;
    }

    resumes.remove(setRestartFlag);
    await new Promise((resolve) => {
      resumes.add(resolve);
    });
  }
}

async function worker(pool, tiles) {
  for await (const { x, y, zoom } of tiles) {
    await renderTile(pool, zoom, x, y, true);
  }
}

async function fillDirtyTilesRegister() {
  console.log('Scanning dirty tiles.');

  const { minLon, maxLon, minLat, maxLat, minZoom, maxZoom } = prerenderConfig;

  for (const { zoom, x, y } of tileRangeGenerator(minLon, maxLon, minLat, maxLat, minZoom, maxZoom)) {
    try {
      const { mtimeMs } = await stat(path.join(tilesDir, `${zoom}/${x}/${y}.png`));
      if (rerenderOlderThanMs && mtimeMs < rerenderOlderThanMs) {
        const v = { zoom, x, y, ts: mtimeMs };
        dirtyTiles.set(tile2key(v), v);
        continue;
      }
    } catch (e) {
      const v = { zoom, x, y, ts: 0 };
      dirtyTiles.set(tile2key(v), v);
      continue;
    }

    try {
      const { mtimeMs } = await stat(path.join(tilesDir, `${zoom}/${x}/${y}.dirty`));
      const v = { zoom, x, y, ts: mtimeMs };
      dirtyTiles.set(tile2key(v), v);
    } catch (e) {
      // fresh
    }
  }

  console.log('Dirty tiles scanned.');
}
