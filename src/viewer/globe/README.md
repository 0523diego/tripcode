# Globe

`<Globe>`: a raw-WebGL2 satellite Earth for the "find a destination" screen (see `docs/FIND-DESTINATION.md`).
No dependency. Files: `Globe.tsx` (component), `globe-engine.ts` (GL, interaction, animation), `globe-math.ts`
(pure maths, tested in `globe-math.test.ts`), `shaders.ts`, `globe.css`.

## Imagery

NASA, public domain (NASA media usage guidelines; credit shown in the component as 「衛星影像：NASA」).
Downloaded from NASA's own servers, then resized and re-compressed with `sips`.

| File | Source | Original | Used |
| --- | --- | --- | --- |
| `textures/earth-day.jpg` | Blue Marble Next Generation, July 2004, with topography and bathymetry (NASA Earth Observatory / Visible Earth): https://assets.science.nasa.gov/content/dam/science/esd/eo/images/bmng/bmng-topography-bathymetry/july/world.topo.bathy.200407.3x5400x2700.jpg | 5400x2700, 2.2 MB | 4096x2048, 1.4 MB |
| `textures/earth-night.jpg` | Black Marble 2012, "Earth at Night" land/ocean/ice composite (NASA Earth Observatory / Visible Earth): https://assets.science.nasa.gov/content/dam/science/esd/eo/images/imagerecords/79000/79765/dnb_land_ocean_ice.2012.3600x1800.jpg | 3600x1800, 0.78 MB | 3072x1536, 0.4 MB |

Credit: NASA Earth Observatory (Blue Marble Next Generation; Black Marble).
