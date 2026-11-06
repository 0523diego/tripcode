// GLSL ES 3.00 (WebGL2). One full-screen triangle; the planet, atmosphere and stars are all ray-traced analytically in
// the fragment shader, so zooming the camera in needs no geometry changes. The camera sits at (0, 0, uCamDist), the
// planet is the unit sphere at the origin, and uRot (world -> view) matches viewMatrix() in globe-math.ts.

export const VERT = /* glsl */ `#version 300 es
out vec2 vNdc;
void main() {
  // ids 0,1,2 -> (-1,-1) (3,-1) (-1,3): one triangle that covers the screen.
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  vNdc = p * 2.0 - 1.0;
  gl_Position = vec4(vNdc, 0.0, 1.0);
}
`;

export const FRAG = /* glsl */ `#version 300 es
precision highp float;
precision highp sampler2D;

in vec2 vNdc;
out vec4 outColor;

uniform mat3 uRot;        // world -> view (column-major)
uniform vec2 uSpan;       // half extents of the view plane at distance 1
uniform float uCamDist;
uniform vec3 uSun;        // unit vector towards the sun, in view space
uniform sampler2D uDay;   // sRGB8_ALPHA8: sampled values are already linear
uniform sampler2D uNight;
uniform vec2 uRes;        // drawing buffer size in device pixels
uniform float uDpr;
uniform float uReveal;    // 0..1: fades the planet in once the textures are ready

const float PI = 3.14159265359;

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

// Sparse, stable star field in screen space with a faint deep-blue wash behind it.
vec3 space(vec2 fragPx, vec2 ndc) {
  float cell = 26.0 * uDpr;
  vec2 id = floor(fragPx / cell);
  vec2 f = fract(fragPx / cell);
  vec3 col = vec3(0.0);
  float rnd = hash12(id);
  if (rnd < 0.16) {
    vec2 c = vec2(hash12(id + 17.3), hash12(id + 91.7)) * 0.7 + 0.15;
    float d = length(f - c) * cell;
    float mag = pow(hash12(id + 3.1), 3.0);
    float size = (0.55 + 1.0 * mag) * uDpr;
    float b = exp(-(d * d) / (size * size)) * (0.18 + 0.82 * mag);
    vec3 tint = mix(vec3(0.72, 0.84, 1.0), vec3(1.0, 0.88, 0.7), hash12(id + 41.9));
    col += tint * b;
  }
  float r = length(ndc);
  vec3 wash = mix(vec3(0.010, 0.020, 0.052), vec3(0.002, 0.004, 0.012), smoothstep(0.0, 1.5, r));
  return col * 0.9 + wash;
}

void main() {
  vec2 fragPx = vNdc * 0.5 * uRes + 0.5 * uRes;
  vec3 ro = vec3(0.0, 0.0, uCamDist);
  vec3 rd = normalize(vec3(vNdc * uSpan, -1.0));

  // Closest approach of the ray to the planet centre.
  float tca = -dot(ro, rd);
  vec3 pc = ro + rd * tca;
  float h = length(pc);

  vec3 bg = space(fragPx, vNdc);

  // --- atmosphere seen past the limb ---
  vec3 limbDir = pc / max(h, 1e-4);
  float sunAtLimb = dot(limbDir, uSun);
  float litLimb = smoothstep(-0.45, 0.55, sunAtLimb);
  float twilightLimb = exp(-pow(sunAtLimb / 0.28, 2.0));
  vec3 atmBlue = vec3(0.20, 0.50, 1.00);
  vec3 atmWarm = vec3(1.00, 0.50, 0.26);
  vec3 atmLimb = mix(atmBlue, atmWarm, twilightLimb * 0.30);
  float outer = exp(-max(h - 1.0, 0.0) * 34.0) * (1.0 - smoothstep(1.12, 1.35, h));
  vec3 glow = atmLimb * outer * (0.07 + 0.93 * litLimb) * 0.95;

  // --- the surface (evaluated with h clamped so the maths stays finite just outside the limb) ---
  float hc = min(h, 0.99995);
  float t = tca - sqrt(1.0 - hc * hc);
  vec3 P = ro + rd * t;
  vec3 n = normalize(P);
  vec3 v = normalize(ro - P);
  vec3 nw = n * uRot;                          // = transpose(uRot) * n : world-space normal
  float lat = asin(clamp(nw.y, -1.0, 1.0));
  float lng = atan(nw.x, nw.z);
  vec2 uv = vec2(lng / (2.0 * PI) + 0.5, 0.5 - lat / PI);

  // Texture gradients without the atan() seam (use the shifted copy of u where the plain one jumps).
  vec2 uvB = vec2(fract(uv.x + 0.5), uv.y);
  vec2 gxA = dFdx(uv);  vec2 gyA = dFdy(uv);
  vec2 gxB = dFdx(uvB); vec2 gyB = dFdy(uvB);
  bool useB = (abs(gxA.x) + abs(gyA.x)) > (abs(gxB.x) + abs(gyB.x));
  vec2 gx = useB ? gxB : gxA;
  vec2 gy = useB ? gyB : gyA;

  vec3 day = textureGrad(uDay, uv, gx, gy).rgb;
  vec3 city = textureGrad(uNight, uv, gx, gy).rgb;

  float ndl = dot(n, uSun);
  float ndv = max(dot(n, v), 0.0);

  // Ocean mask from the day texture: deep blue, little red.
  float oceanMask = (1.0 - smoothstep(0.012, 0.075, day.r)) * smoothstep(0.0, 0.02, day.b - day.r);

  float dayAmt = smoothstep(-0.09, 0.32, ndl);          // soft terminator
  float diffuse = smoothstep(-0.12, 0.62, ndl);
  vec3 lit = day * (1.45 * diffuse);

  // Specular glint and grazing sheen on the sea.
  vec3 hv = normalize(uSun + v);
  float nh = max(dot(n, hv), 0.0);
  float spec = pow(nh, 420.0) * 0.55 + pow(nh, 70.0) * 0.045;
  float fres = pow(1.0 - ndv, 4.0);
  vec3 sea = vec3(0.35, 0.62, 1.0) * fres * 0.30 + vec3(1.0, 0.96, 0.88) * spec;
  lit += sea * oceanMask * dayAmt;

  // Night side: city lights + a trace of earthshine so the continents stay readable.
  float nightAmt = 1.0 - smoothstep(-0.16, 0.10, ndl);
  float lum = dot(city, vec3(0.299, 0.587, 0.114));
  vec3 lights = pow(city, vec3(0.78)) * vec3(1.0, 0.80, 0.52) * 2.6 * smoothstep(0.004, 0.05, lum);
  vec3 earthshine = day * vec3(0.45, 0.65, 1.0) * 0.03;
  vec3 night = (lights + earthshine) * nightAmt;

  // Orange fringe along the terminator.
  float twilight = exp(-pow(ndl / 0.08, 2.0)) * 0.05;
  vec3 surface = lit + night + vec3(1.0, 0.42, 0.18) * twilight * (0.3 + day.g);

  // Thin haze inside the limb, brightest on the sunlit side.
  float sunLitHaze = smoothstep(-0.40, 0.50, ndl);
  float twiHaze = exp(-pow(ndl / 0.26, 2.0));
  vec3 atmIn = mix(atmBlue, atmWarm, twiHaze * 0.16);
  float haze = pow(1.0 - ndv, 3.2);
  surface += atmIn * haze * (0.05 + 0.95 * sunLitHaze) * 1.05;
  surface += atmBlue * 0.020 * (1.0 - ndv) * sunLitHaze;     // faint veil over the whole day side

  // Anti-aliased silhouette: blend surface over glow/space.
  float w = max(fwidth(h) * 0.9, 1e-4);
  float cover = 1.0 - smoothstep(1.0 - w, 1.0 + w, h);
  vec3 col = bg * (1.0 - cover * uReveal) + (glow * (1.0 - cover) + surface * cover) * uReveal;

  // Tone map (ACES approximation), then gamma.
  col *= 0.92;
  col = clamp((col * (2.51 * col + 0.03)) / (col * (2.43 * col + 0.59) + 0.14), 0.0, 1.0);
  col = pow(col, vec3(1.0 / 2.2));
  col += (hash12(fragPx + 0.5) - 0.5) / 255.0;   // dither away banding in the dark gradients
  outColor = vec4(col, 1.0);
}
`;
