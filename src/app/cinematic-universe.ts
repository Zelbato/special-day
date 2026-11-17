import {
  ACESFilmicToneMapping,
  AdditiveBlending,
  BackSide,
  BufferGeometry,
  Color,
  ConeGeometry,
  CubeCamera,
  CustomBlending,
  CylinderGeometry,
  DoubleSide,
  Float32BufferAttribute,
  Group,
  HalfFloatType,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  LinearFilter,
  Matrix3,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  OneFactor,
  OneMinusSrcAlphaFactor,
  PerspectiveCamera,
  PlaneGeometry,
  Points,
  Scene,
  ShaderMaterial,
  SphereGeometry,
  SRGBColorSpace,
  Vector2,
  Vector3,
  WebGLCubeRenderTarget,
  WebGLRenderer,
  WebGLRenderTarget,
} from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

/**
 * Cinematic WebGL universe (Three.js): ray-traced black hole with gravitational lensing,
 * HDR bloom, instanced star fields, particle orbits and a heart-shaped galaxy.
 *
 * Same contract as the Canvas 2D renderer, so the film timeline in app.ts drives it unchanged.
 * Renders at the screen's real pixel density (up to 4K) and adapts resolution to hold 60fps.
 */

const NOISE = /* glsl */ `
  float hash13(vec3 p) {
    p = fract(p * 0.1031);
    p += dot(p, p.zyx + 31.32);
    return fract((p.x + p.y) * p.z);
  }
  float noise3(vec3 p) {
    vec3 i = floor(p);
    vec3 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(mix(hash13(i), hash13(i + vec3(1, 0, 0)), f.x), mix(hash13(i + vec3(0, 1, 0)), hash13(i + vec3(1, 1, 0)), f.x), f.y),
      mix(mix(hash13(i + vec3(0, 0, 1)), hash13(i + vec3(1, 0, 1)), f.x), mix(hash13(i + vec3(0, 1, 1)), hash13(i + vec3(1, 1, 1)), f.x), f.y),
      f.z);
  }
  float fbm(vec3 p) {
    float v = 0.0;
    float a = 0.5;
    for (int i = 0; i < 6; i++) {
      v += a * noise3(p);
      p = p * 2.03 + vec3(1.7, 9.2, 3.1);
      a *= 0.5;
    }
    return v;
  }
`;

/* ---------- Sky: painted once into a cube map (nebulae, Milky Way band, dust lanes) ---------- */
const SKY_BAKE_VERTEX = /* glsl */ `
  varying vec3 vDir;
  void main() {
    vDir = position;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;
const SKY_BAKE_FRAGMENT = /* glsl */ `
  varying vec3 vDir;
  ${NOISE}
  void main() {
    vec3 d = normalize(vDir);
    vec3 n = normalize(vec3(0.32, 1.0, -0.42));
    float lat = dot(d, n);
    float band = exp(-lat * lat * 14.0);
    float core = exp(-pow(length(d - normalize(vec3(-0.75, 0.1, -0.65))), 2.0) * 3.0);
    float f = fbm(d * 3.2);
    float f2 = fbm(d * 8.0 + 4.0);
    float dust = smoothstep(0.42, 0.72, fbm(d * 6.0 + 10.0)) * smoothstep(0.0, 0.6, band);
    vec3 col = vec3(0.0011, 0.0016, 0.0042);
    vec3 bandCol = mix(vec3(0.05, 0.045, 0.085), vec3(0.16, 0.11, 0.075), f);
    col += bandCol * band * smoothstep(0.2, 0.8, f2) * (0.6 + core * 2.5) * (1.0 - dust * 0.95);
    col += vec3(0.30, 0.20, 0.13) * core * band * f2 * 0.35 * (1.0 - dust);
    col += vec3(0.075, 0.042, 0.12) * pow(smoothstep(0.38, 0.85, fbm(d * 1.7 + 1.0)), 2.2) * 0.9;
    col += vec3(0.14, 0.065, 0.032) * pow(smoothstep(0.42, 0.85, fbm(d * 2.1 + 7.0)), 2.2) * 0.8;
    col += vec3(0.03, 0.07, 0.09) * pow(smoothstep(0.45, 0.85, fbm(d * 2.6 + 13.0)), 2.2) * 0.7;
    // unresolved star haze
    col += vec3(0.6, 0.6, 0.7) * pow(hash13(floor(d * 700.0)), 90.0) * 0.25;
    gl_FragColor = vec4(col, 1.0);
  }
`;
const SKY_VERTEX = /* glsl */ `
  varying vec3 vDir;
  void main() {
    vDir = (modelMatrix * vec4(position, 0.0)).xyz;
    vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    gl_Position = p.xyww;
  }
`;
const SKY_FRAGMENT = /* glsl */ `
  uniform samplerCube uSky;
  uniform float uWarm;
  uniform float uBright;
  varying vec3 vDir;
  void main() {
    vec3 col = textureCube(uSky, normalize(vDir)).rgb * uBright;
    vec3 warm = col * vec3(1.25, 0.78, 0.95) + vec3(0.004, 0.0008, 0.0022);
    gl_FragColor = vec4(mix(col, warm, uWarm), 1.0);
  }
`;

/* ---------- Black hole: per-pixel null-geodesic integration (Schwarzschild, Rs = 1) ---------- */
const HOLE_VERTEX = /* glsl */ `
  uniform mat4 uInvViewProj;
  uniform vec3 uCamPos;
  varying vec3 vDir;
  void main() {
    vec4 p = uInvViewProj * vec4(position.xy, 1.0, 1.0);
    vDir = p.xyz / p.w - uCamPos;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;
const HOLE_FRAGMENT = /* glsl */ `
  uniform samplerCube uSky;
  uniform vec3 uCamLocal;
  uniform mat3 uToLocal;
  uniform mat3 uToWorld;
  uniform float uTime;
  uniform float uOpacity;
  varying vec3 vDir;
  ${NOISE}

  vec3 starLayer(vec3 d, float scale, float density) {
    vec3 p = d * scale;
    vec3 c = floor(p);
    float h = hash13(c);
    if (h < density) return vec3(0.0);
    vec3 o = 0.2 + 0.6 * vec3(hash13(c + 1.3), hash13(c + 2.7), hash13(c + 5.1));
    float dist = length(fract(p) - o);
    float b = exp(-dist * dist * 900.0) * (h - density) / (1.0 - density);
    vec3 tint = mix(vec3(0.75, 0.85, 1.0), vec3(1.0, 0.82, 0.62), hash13(c + 9.4));
    return tint * b * 2.5;
  }

  vec4 disk(vec3 p, vec3 d) {
    float r = length(p.xz);
    float inner = 2.6;
    float outer = 13.5;
    if (r < inner || r > outer) return vec4(0.0);
    float omega = 2.4 * pow(r, -1.5);
    float ang = uTime * omega;
    float cs = cos(ang);
    float sn = sin(ang);
    vec2 q = vec2(cs * p.x - sn * p.z, sn * p.x + cs * p.z);
    float n1 = noise3(vec3(q * 0.8, r * 0.5));
    float n2 = noise3(vec3(q * 2.4, r * 1.6 + 3.0));
    float n3 = noise3(vec3(q * 6.5, r * 4.2 + 7.0));
    float turb = n1 * 0.5 + n2 * 0.32 + n3 * 0.18;
    float rings = 0.3 + 0.7 * smoothstep(0.2, 0.9, noise3(vec3(r * 2.2, turb * 3.0, 1.7)) * 0.75 + n3 * 0.25);
    float x = (r - inner) / (outer - inner);
    float profile = smoothstep(0.0, 0.05, x) * (1.0 - smoothstep(0.45, 1.0, x)) * pow(inner / r, 1.3);
    vec3 hot = vec3(1.0, 0.9, 0.74);
    vec3 mid = vec3(1.0, 0.56, 0.22);
    vec3 cool = vec3(0.55, 0.16, 0.05);
    vec3 c = mix(hot, mid, smoothstep(0.0, 0.3, x));
    c = mix(c, cool, smoothstep(0.3, 1.0, x));
    vec3 vdir = normalize(vec3(-p.z, 0.0, p.x));
    float beta = 0.62 * sqrt(1.0 / (2.0 * max(r - 1.0, 0.6)));
    float cosT = dot(vdir, -d);
    float D = sqrt(1.0 - beta * beta) / (1.0 - beta * cosT);
    float boost = pow(D, 3.0);
    c = mix(c, c * vec3(0.82, 0.95, 1.3), clamp((D - 1.0) * 1.4, 0.0, 1.0));
    c = mix(c, c * vec3(1.1, 0.7, 0.5), clamp((1.0 - D) * 1.4, 0.0, 1.0));
    float grav = sqrt(max(1.0 - 1.0 / r, 0.0));
    float dens = profile * (0.3 + 0.7 * turb) * (0.45 + 0.55 * rings);
    vec3 e = c * dens * boost * grav * 2.4;
    float a = clamp(dens * 1.5, 0.0, 1.0);
    return vec4(e, a);
  }

  void main() {
    if (uOpacity <= 0.001) discard;
    vec3 dir = normalize(uToLocal * normalize(vDir));
    vec3 pos = uCamLocal;
    float b = length(cross(pos, dir));
    float outerR = 24.0;
    float mask = 1.0 - smoothstep(13.0, 22.5, b);
    if (mask <= 0.0) discard;
    float r0 = length(pos);
    if (r0 > outerR) {
      float bb = dot(pos, dir);
      float disc = bb * bb - (r0 * r0 - outerR * outerR);
      if (disc < 0.0 || bb > 0.0) discard;
      pos += dir * (-bb - sqrt(disc));
    }
    float h2 = b * b;
    vec3 vel = dir;
    vec3 col = vec3(0.0);
    float alpha = 0.0;
    bool captured = false;
    for (int i = 0; i < 220; i++) {
      float r2 = dot(pos, pos);
      float r = sqrt(r2);
      if (r < 1.0) { captured = true; break; }
      if (r > outerR + 0.5 && dot(pos, vel) > 0.0) break;
      float stepSize = clamp(0.045 * r, 0.012, 1.0);
      vec3 acc = -1.5 * h2 * pos / (r2 * r2 * r);
      vec3 prev = pos;
      vel += acc * stepSize;
      pos += vel * stepSize;
      if (prev.y * pos.y < 0.0) {
        float tt = prev.y / (prev.y - pos.y);
        vec4 dc = disk(mix(prev, pos, tt), normalize(vel));
        col += (1.0 - alpha) * dc.rgb;
        alpha += (1.0 - alpha) * dc.a;
        if (alpha > 0.995) break;
      }
    }
    vec3 bg = vec3(0.0);
    if (!captured) {
      vec3 wd = normalize(uToWorld * normalize(vel));
      bg = textureCube(uSky, wd).rgb + starLayer(wd, 260.0, 0.93) + starLayer(wd, 120.0, 0.975) * 1.6;
    }
    vec3 outc = col + (1.0 - alpha) * mask * bg;
    float outa = alpha + (1.0 - alpha) * mask;
    gl_FragColor = vec4(outc, outa) * uOpacity;
  }
`;

/* ---------- Stars: instanced quads that stretch into motion streaks at warp speed ---------- */
const STAR_VERTEX = /* glsl */ `
  uniform float uTravel;
  uniform float uDepth;
  uniform float uStreak;
  uniform float uPixelRatio;
  uniform float uTime;
  uniform float uOpacity;
  uniform float uWrap;
  uniform float uAtten;
  uniform vec2 uResolution;
  attribute vec3 aPos;
  attribute float aSize;
  attribute vec3 aColor;
  attribute float aSeed;
  varying float vAlong;
  varying float vAcross;
  varying float vLen;
  varying float vPx;
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    vec3 head = aPos;
    if (uWrap > 0.5) head.z = mod(aPos.z + uTravel, uDepth) - uDepth - 2.0;
    vec4 vh = modelViewMatrix * vec4(head, 1.0);
    vec4 vt = modelViewMatrix * vec4(head - vec3(0.0, 0.0, uStreak), 1.0);
    vt.z = min(vt.z, -0.2);
    vec4 ch = projectionMatrix * vh;
    vec4 ct = projectionMatrix * vt;
    vec2 half_ = 0.5 * uResolution;
    vec2 sh = ch.xy / ch.w * half_;
    vec2 st = ct.xy / ct.w * half_;
    float dist = -vh.z;
    float px = max(1.6, aSize * uPixelRatio * mix(1.0, clamp(90.0 / dist, 0.5, 1.6), uAtten));
    vec2 axis = sh - st;
    float len = length(axis);
    vec2 dir = len > 0.001 ? axis / len : vec2(1.0, 0.0);
    vec2 nrm = vec2(-dir.y, dir.x);
    vec2 p = mix(st, sh, position.y) + dir * (position.y * 2.0 - 1.0) * px + nrm * position.x * px;
    vAlong = mix(-px, len + px, position.y);
    vAcross = position.x * px;
    vLen = len;
    vPx = px;
    float tw = 0.78 + 0.22 * sin(uTime * (0.7 + aSeed * 2.6) + aSeed * 50.0);
    float fade = uWrap > 0.5 ? (1.0 - smoothstep(uDepth * 0.2, uDepth * 0.85, dist)) * smoothstep(1.0, 8.0, dist) : 1.0;
    // a streak spreads the same light over more pixels
    float energy = max(0.1, 1.0 / (1.0 + len / (px * 20.0)));
    vAlpha = uOpacity * tw * fade * energy;
    vColor = aColor;
    float z = mix(ct.z / ct.w, ch.z / ch.w, position.y);
    gl_Position = vec4(p / half_, z, 1.0);
    if (vh.z > -0.2 || uOpacity <= 0.0) gl_Position = vec4(3.0, 3.0, 3.0, 1.0);
  }
`;
const STAR_FRAGMENT = /* glsl */ `
  varying float vAlong;
  varying float vAcross;
  varying float vLen;
  varying float vPx;
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    float a = clamp(vAlong, 0.0, vLen);
    float d = length(vec2(vAlong - a, vAcross)) / vPx;
    if (d > 1.0) discard;
    float core = exp(-d * d * 7.0);
    float halo = exp(-d * d * 2.5) * 0.12;
    float tail = vLen > 0.5 ? mix(0.08, 1.0, pow(a / vLen, 1.6)) : 1.0;
    gl_FragColor = vec4(vColor * (core + halo) * tail * vAlpha, 1.0);
  }
`;

/* ---------- Soft particles (gl_PointSize sprites) ---------- */
const SPRITE_FRAGMENT = /* glsl */ `
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    vec2 c = gl_PointCoord - 0.5;
    float d = dot(c, c) * 4.0;
    if (d > 1.0) discard;
    float a = exp(-d * 5.5) + exp(-d * 1.6) * 0.12;
    gl_FragColor = vec4(vColor * a * vAlpha, 1.0);
  }
`;

const HEART_VERTEX = /* glsl */ `
  uniform float uTime;
  uniform float uReveal;
  uniform float uPulse;
  uniform float uPixelRatio;
  uniform float uOpacity;
  attribute float aA;
  attribute float aMode;
  attribute vec2 aXY;
  attribute float aFill;
  attribute float aZ;
  attribute float aSize;
  attribute float aGlow;
  attribute float aSeed;
  attribute vec3 aScatter;
  attribute vec3 aColor;
  varying vec3 vColor;
  varying float vAlpha;
  vec2 heart(float a) {
    float s = sin(a);
    return vec2(16.0 * s * s * s, 13.0 * cos(a) - 5.0 * cos(2.0 * a) - 2.0 * cos(3.0 * a) - cos(4.0 * a));
  }
  void main() {
    vec2 h;
    if (aMode < 0.5) {
      // rim: stars flowing along the outline
      float a = aA + sin(uTime * (0.2 + aSeed * 0.3) + aSeed * 60.0) * 0.012;
      h = heart(a) * aFill + vec2(0.0, 2.6 * aFill);
    } else {
      // body: the core turns gently like a galaxy, the edges stay put
      float k = (1.0 - aFill) * (1.0 - aFill);
      float sw = k * (0.6 + 0.35 * sin(uTime * 0.18)) + sin(uTime * 0.4 + aSeed * 40.0) * 0.015;
      vec2 q = aXY - vec2(0.0, 0.5);
      h = vec2(cos(sw) * q.x - sin(sw) * q.y, sin(sw) * q.x + cos(sw) * q.y) + vec2(0.0, 0.5);
    }
    vec3 p = vec3(h, aZ * (1.25 - aFill * 0.8)) * 0.62 * uPulse;
    p.z += sin(uTime * 0.6 + aSeed * 30.0) * 0.08;
    float r = smoothstep(aSeed * 0.55, aSeed * 0.55 + 0.45, uReveal);
    float ease = r * r * (3.0 - 2.0 * r);
    vec3 swirl = aScatter;
    float sa = (1.0 - ease) * 2.4;
    swirl.xz = mat2(cos(sa), -sin(sa), sin(sa), cos(sa)) * swirl.xz;
    p = mix(swirl, p, ease);
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_PointSize = aSize * uPixelRatio * (34.0 / -mv.z);
    gl_Position = projectionMatrix * mv;
    float tw = aGlow > 2.0 ? 0.55 + 0.45 * sin(uTime * (1.5 + aSeed * 3.0) + aSeed * 90.0) : 1.0;
    vColor = aColor;
    vAlpha = aGlow * tw * uOpacity * mix(0.3, 1.0, ease);
  }
`;

const TRAIL_VERTEX = /* glsl */ `
  uniform float uAngle;
  uniform float uRadius;
  uniform float uConvX;
  uniform float uConvZ;
  uniform float uLen;
  uniform float uTime;
  uniform float uPixelRatio;
  uniform float uOpacity;
  uniform vec3 uWarm;
  uniform vec3 uCool;
  attribute float aIdx;
  attribute float aSide;
  attribute vec3 aJit;
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    float b = uAngle - aIdx * uLen + aSide * 3.14159265;
    vec3 p = vec3(cos(b) * uRadius * uConvX, 0.0, sin(b) * uRadius * uConvZ);
    p += aJit * (0.05 + aIdx * 0.75) + vec3(0.0, sin(uTime * 1.3 + aIdx * 20.0) * 0.06 * aIdx, 0.0);
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    float k = pow(1.0 - aIdx, 1.7);
    gl_PointSize = (2.0 + 7.0 * k) * uPixelRatio * (26.0 / -mv.z);
    gl_Position = projectionMatrix * mv;
    vColor = mix(uCool, uWarm, aSide);
    vAlpha = k * 0.9 * uOpacity;
  }
`;

const DUST_VERTEX = /* glsl */ `
  uniform float uTime;
  uniform float uPixelRatio;
  uniform float uOpacity;
  attribute float aAngle;
  attribute float aRadius;
  attribute float aY;
  attribute float aSize;
  attribute vec3 aColor;
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    float a = aAngle + uTime * 0.6 / pow(aRadius, 1.2);
    vec3 p = vec3(cos(a) * aRadius, aY, sin(a) * aRadius);
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_PointSize = aSize * uPixelRatio * (26.0 / -mv.z);
    gl_Position = projectionMatrix * mv;
    vColor = aColor;
    vAlpha = uOpacity;
  }
`;

const BRIDGE_VERTEX = /* glsl */ `
  uniform vec3 uA;
  uniform vec3 uB;
  uniform float uTime;
  uniform float uConn;
  uniform float uPixelRatio;
  uniform float uOpacity;
  attribute float aU;
  attribute float aSeed;
  attribute vec3 aJit;
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    float dirn = aSeed > 0.5 ? 1.0 : -1.0;
    float u = fract(aU + uTime * (0.08 + aSeed * 0.08) * dirn);
    float arc = sin(u * 3.14159265);
    vec3 p = mix(uA, uB, u) + aJit * arc * (0.25 + (1.0 - uConn) * 0.9);
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_PointSize = (2.0 + aSeed * 3.0) * uPixelRatio * (26.0 / -mv.z);
    gl_Position = projectionMatrix * mv;
    vColor = mix(vec3(1.0, 0.78, 0.55), vec3(0.75, 0.84, 1.0), u) * 2.2;
    vAlpha = (0.15 + uConn * 0.85) * arc * uOpacity;
  }
`;

const SPARK_VERTEX = /* glsl */ `
  uniform float uFlight;
  uniform vec3 uStart;
  uniform vec3 uEnd;
  uniform float uArc;
  uniform float uPixelRatio;
  uniform float uOpacity;
  uniform float uTime;
  attribute float aIdx;
  attribute vec3 aJit;
  varying vec3 vColor;
  varying float vAlpha;
  vec3 path(float f) {
    return mix(uStart, uEnd, f) + vec3(0.0, sin(f * 3.14159265) * uArc, 0.0);
  }
  void main() {
    float f = uFlight - aIdx * 0.3;
    vec3 p = path(clamp(f, 0.0, 1.2)) + aJit * aIdx * 1.4 - vec3(0.0, aIdx * aIdx * 1.2, 0.0);
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    float k = 1.0 - aIdx;
    gl_PointSize = (1.5 + 4.5 * k) * uPixelRatio * (26.0 / -mv.z);
    gl_Position = projectionMatrix * mv;
    vColor = mix(vec3(1.0, 0.5, 0.25), vec3(1.0, 0.85, 0.6), k) * 3.0;
    float tw = 0.6 + 0.4 * sin(uTime * 20.0 + aIdx * 300.0);
    vAlpha = (f > 0.0 ? 1.0 : 0.0) * k * tw * uOpacity;
  }
`;

/* ---------- Stellar surfaces and coronas ---------- */
const BODY_VERTEX = /* glsl */ `
  varying vec3 vN;
  varying vec3 vV;
  varying vec3 vP;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vN = normalize(normalMatrix * normal);
    vV = -mv.xyz;
    vP = position;
    gl_Position = projectionMatrix * mv;
  }
`;
const BODY_FRAGMENT = /* glsl */ `
  uniform vec3 uColor;
  uniform float uTime;
  uniform float uIntensity;
  varying vec3 vN;
  varying vec3 vV;
  varying vec3 vP;
  ${NOISE}
  void main() {
    float mu = clamp(dot(normalize(vN), normalize(vV)), 0.0, 1.0);
    float limb = pow(mu, 0.5);
    vec3 q = normalize(vP) * 3.5;
    float g = fbm(q + vec3(0.0, uTime * 0.12, uTime * 0.05));
    float cells = noise3(q * 4.0 + uTime * 0.3);
    vec3 col = uColor * (0.6 + 2.2 * limb) * (0.65 + 0.55 * g + 0.25 * cells);
    col += vec3(1.0, 0.95, 0.9) * pow(limb, 3.0) * 1.2;
    gl_FragColor = vec4(col * uIntensity, uIntensity);
  }
`;
const CORONA_VERTEX = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;
const CORONA_FRAGMENT = /* glsl */ `
  uniform vec3 uColor;
  uniform float uIntensity;
  uniform float uTime;
  uniform float uSpikes;
  varying vec2 vUv;
  void main() {
    vec2 c = (vUv - 0.5) * 2.0;
    float r = length(c);
    if (r > 1.0) discard;
    float glow = 0.022 / (r * r + 0.012) - 0.022 / 1.012;
    float ang = atan(c.y, c.x);
    float rays = pow(abs(cos(ang * 2.0 + 0.3)), 60.0) * exp(-r * 4.0) * uSpikes;
    float flare = exp(-abs(c.y) * 90.0) * exp(-abs(c.x) * 3.0) * 0.6 * uSpikes;
    float flick = 0.94 + 0.06 * sin(uTime * 3.1 + r * 9.0);
    float edge = 1.0 - smoothstep(0.7, 1.0, r);
    gl_FragColor = vec4(uColor * (glow * flick + rays + flare) * edge * uIntensity, 1.0);
  }
`;

/* ---------- Final grade: lens vignette, faint chromatic fringe, flash ---------- */
const GRADE_SHADER = {
  uniforms: {
    tDiffuse: { value: null },
    uFlash: { value: 0 },
    uAspect: { value: 1 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uFlash;
    uniform float uAspect;
    varying vec2 vUv;
    void main() {
      vec2 c = vUv - 0.5;
      float r2 = dot(c * vec2(uAspect, 1.0), c * vec2(uAspect, 1.0));
      vec2 off = c * r2 * 0.006;
      vec3 col;
      col.r = texture2D(tDiffuse, vUv - off).r;
      col.g = texture2D(tDiffuse, vUv).g;
      col.b = texture2D(tDiffuse, vUv + off).b;
      float v = length(c * vec2(1.0, 0.82)) * 1.35;
      col *= mix(0.28, 1.0, 1.0 - smoothstep(0.25, 1.0, v));
      col += vec3(1.0, 0.92, 0.82) * uFlash;
      gl_FragColor = vec4(col, 1.0);
    }
  `,
};

interface Shot {
  pos: Vector3;
  look: Vector3;
  fov: number;
  roll: number;
}

const damp = (current: number, target: number, rate: number, dt: number) =>
  current + (target - current) * (1 - Math.exp(-rate * dt));
const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const gauss = () => {
  let u = 0;
  let v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
};

const ORBIT_RADIUS = 8;

export class CinematicUniverse {
  reducedMotion = false;
  private readonly renderer: WebGLRenderer;
  private readonly composer: EffectComposer;
  private readonly bloom: UnrealBloomPass;
  private readonly grade: ShaderPass;
  private readonly scene = new Scene();
  private readonly camera = new PerspectiveCamera(38, 1, 0.1, 5000);
  private readonly skyTarget: WebGLCubeRenderTarget;
  private readonly skyMesh: Mesh<SphereGeometry, ShaderMaterial>;
  private readonly hole: Mesh<BufferGeometry, ShaderMaterial>;
  private readonly holeFrame = new Group();
  private readonly skyStars: Mesh<InstancedBufferGeometry, ShaderMaterial>;
  private readonly fieldStars: Mesh<InstancedBufferGeometry, ShaderMaterial>;
  private readonly warpStars: Mesh<InstancedBufferGeometry, ShaderMaterial>;
  private readonly system = new Group();
  private readonly bodies: { mesh: Mesh<SphereGeometry, ShaderMaterial>; corona: Mesh<PlaneGeometry, ShaderMaterial> }[] = [];
  private readonly trails: Points<BufferGeometry, ShaderMaterial>;
  private readonly dust: Points<BufferGeometry, ShaderMaterial>;
  private readonly bridge: Points<BufferGeometry, ShaderMaterial>;
  private readonly meetGlow: Mesh<PlaneGeometry, ShaderMaterial>;
  private readonly arrow = new Group();
  private readonly arrowMaterials: MeshBasicMaterial[] = [];
  private readonly arrowGlow: Mesh<PlaneGeometry, ShaderMaterial>;
  private readonly sparks: Points<BufferGeometry, ShaderMaterial>;
  private readonly heart = new Group();
  private readonly heartPoints: Points<BufferGeometry, ShaderMaterial>;
  private readonly heartGlow: Mesh<PlaneGeometry, ShaderMaterial>;
  private readonly labels: HTMLElement[] = [];
  private readonly labelLayer: HTMLElement;
  private width = 1;
  private height = 1;
  private pixelRatio = 1;
  private maxPixelRatio = 1;
  private lastTime = 0;
  private lastFrame = 0;
  private frameMs = 16.7;
  private qualityTimer = 0;
  private goodTime = 0;
  private travel = 0;
  private speed = 0;
  private orbitAngle = 0;
  private trailLength = 1.1;
  private readonly opacity = { hole: 1, warp: 0, system: 0, heart: 0, warm: 0 };
  private readonly pointer = new Vector2();
  private readonly pointerSmooth = new Vector2();
  private readonly camPos = new Vector3(0, 4.5, 38);
  private readonly camLook = new Vector3(0, -1.2, 0);
  private camFov = 38;
  private camRoll = 0;
  private lastScene = -1;
  private readonly tmp = new Vector3();
  private readonly tmp2 = new Vector3();
  private readonly arrowStart = new Vector3(-ORBIT_RADIUS * 1.9, 4.2, -3);
  private readonly arrowEnd = new Vector3(ORBIT_RADIUS * 2.4, 1.2, 3.5);
  private readonly up = new Vector3(0, 1, 0);
  private readonly onContextLost = (event: Event) => event.preventDefault();

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.renderer = new WebGLRenderer({
      canvas,
      antialias: false,
      alpha: false,
      stencil: false,
      powerPreference: 'high-performance',
    });
    this.renderer.outputColorSpace = SRGBColorSpace;
    this.renderer.toneMapping = ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.setClearColor(0x020308, 1);
    canvas.addEventListener('webglcontextlost', this.onContextLost);

    this.maxPixelRatio = this.computeMaxPixelRatio();
    this.pixelRatio = this.maxPixelRatio;
    const samples = (window.devicePixelRatio || 1) >= 1.5 ? 0 : 4;
    const target = new WebGLRenderTarget(1, 1, { type: HalfFloatType, samples });
    this.composer = new EffectComposer(this.renderer, target);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(new Vector2(256, 256), 0.55, 0.45, 0.9);
    this.composer.addPass(this.bloom);
    this.grade = new ShaderPass(GRADE_SHADER);
    this.composer.addPass(this.grade);
    this.composer.addPass(new OutputPass());

    this.scene.add(this.camera);

    // Sky: bake the nebula field once, then sample it (cheap at 4K).
    this.skyTarget = new WebGLCubeRenderTarget(2048, {
      type: HalfFloatType,
      generateMipmaps: false,
      minFilter: LinearFilter,
      magFilter: LinearFilter,
    });
    const bakeScene = new Scene();
    const bakeMaterial = new ShaderMaterial({
      vertexShader: SKY_BAKE_VERTEX,
      fragmentShader: SKY_BAKE_FRAGMENT,
      side: BackSide,
      depthWrite: false,
    });
    const bakeMesh = new Mesh(new SphereGeometry(100, 64, 32), bakeMaterial);
    bakeScene.add(bakeMesh);
    const cubeCamera = new CubeCamera(1, 1000, this.skyTarget);
    cubeCamera.update(this.renderer, bakeScene);
    bakeMesh.geometry.dispose();
    bakeMaterial.dispose();

    this.skyMesh = new Mesh(
      new SphereGeometry(2000, 64, 32),
      new ShaderMaterial({
        vertexShader: SKY_VERTEX,
        fragmentShader: SKY_FRAGMENT,
        uniforms: {
          uSky: { value: this.skyTarget.texture },
          uWarm: { value: 0 },
          uBright: { value: 1 },
        },
        side: BackSide,
        depthWrite: false,
        depthTest: false,
      }),
    );
    this.skyMesh.renderOrder = -100;
    this.skyMesh.frustumCulled = false;
    this.scene.add(this.skyMesh);

    // Star layers
    this.skyStars = this.createStars(14000, 'sky');
    this.skyStars.renderOrder = -90;
    this.scene.add(this.skyStars);
    this.fieldStars = this.createStars(2600, 'field');
    this.scene.add(this.fieldStars);
    this.warpStars = this.createStars(7000, 'warp');
    this.camera.add(this.warpStars);

    // Black hole (screen-space ray tracer)
    const holeGeometry = new BufferGeometry();
    holeGeometry.setAttribute('position', new Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
    this.hole = new Mesh(
      holeGeometry,
      new ShaderMaterial({
        vertexShader: HOLE_VERTEX,
        fragmentShader: HOLE_FRAGMENT,
        uniforms: {
          uSky: { value: this.skyTarget.texture },
          uCamLocal: { value: new Vector3() },
          uCamPos: { value: new Vector3() },
          uInvViewProj: { value: new Matrix4() },
          uToLocal: { value: new Matrix3() },
          uToWorld: { value: new Matrix3() },
          uTime: { value: 0 },
          uOpacity: { value: 1 },
        },
        transparent: true,
        depthTest: false,
        depthWrite: false,
        blending: CustomBlending,
        blendSrc: OneFactor,
        blendDst: OneMinusSrcAlphaFactor,
      }),
    );
    this.hole.frustumCulled = false;
    this.hole.renderOrder = 100;
    this.scene.add(this.hole);
    this.holeFrame.rotation.set(0.05, 0, 0.2);
    this.holeFrame.updateMatrixWorld();

    // Orbits: two stars, dust rings, trails
    this.system.rotation.set(0, 0, 0.12);
    this.scene.add(this.system);
    const warm = new Color('#ffcf98');
    const cool = new Color('#a9c4ff');
    for (const color of [warm, cool]) {
      const mesh = new Mesh(
        new SphereGeometry(0.55, 64, 32),
        new ShaderMaterial({
          vertexShader: BODY_VERTEX,
          fragmentShader: BODY_FRAGMENT,
          uniforms: { uColor: { value: color }, uTime: { value: 0 }, uIntensity: { value: 1 } },
          transparent: true,
        }),
      );
      const corona = this.createCorona(color, 9, 1);
      this.system.add(mesh, corona);
      this.bodies.push({ mesh, corona });
    }
    this.dust = this.createDust();
    this.system.add(this.dust);
    this.trails = this.createTrails(warm, cool);
    this.system.add(this.trails);
    this.bridge = this.createBridge();
    this.system.add(this.bridge);
    this.meetGlow = this.createCorona(new Color('#ffe2c2'), 10, 0.8);
    this.system.add(this.meetGlow);

    // Cupid's arrow
    const shaftMaterial = new MeshBasicMaterial({ color: new Color(3.2, 2.1, 1.1), transparent: true });
    const headMaterial = new MeshBasicMaterial({ color: new Color(6, 3.6, 1.6), transparent: true });
    const featherMaterial = new MeshBasicMaterial({ color: new Color(2.4, 0.9, 0.8), transparent: true, side: DoubleSide });
    this.arrowMaterials.push(shaftMaterial, headMaterial, featherMaterial);
    const shaft = new Mesh(new CylinderGeometry(0.03, 0.03, 2.6, 12), shaftMaterial);
    const head = new Mesh(new ConeGeometry(0.11, 0.42, 16), headMaterial);
    head.position.y = 1.5;
    this.arrow.add(shaft, head);
    for (let i = 0; i < 3; i++) {
      const feather = new Mesh(new PlaneGeometry(0.22, 0.5), featherMaterial);
      feather.position.y = -1.1;
      feather.position.x = 0.11;
      const holder = new Group();
      holder.rotation.y = (i / 3) * Math.PI * 2;
      holder.add(feather);
      this.arrow.add(holder);
    }
    this.arrowGlow = this.createCorona(new Color('#ffc58a'), 4, 1);
    this.system.add(this.arrow, this.arrowGlow);
    this.sparks = this.createSparks();
    this.system.add(this.sparks);

    // Heart galaxy
    this.heartPoints = this.createHeart();
    this.heartGlow = this.createCorona(new Color('#ff9a7a'), 30, 0);
    this.heart.add(this.heartGlow, this.heartPoints);
    this.scene.add(this.heart);

    // Crisp HTML labels that follow the stars
    this.labelLayer = document.createElement('div');
    this.labelLayer.setAttribute('aria-hidden', 'true');
    Object.assign(this.labelLayer.style, {
      position: 'absolute',
      inset: '0',
      pointerEvents: 'none',
      zIndex: '2',
      overflow: 'hidden',
    });
    const labelText: [string, string, string][] = [
      ['EU', '#e2c39b', 'normal'],
      ['VOCÊ', '#c3d2ee', 'normal'],
      ['errou. de novo.', '#c9b597', 'italic'],
    ];
    for (const [text, color, style] of labelText) {
      const label = document.createElement('span');
      label.textContent = text;
      const italic = style === 'italic';
      Object.assign(label.style, {
        position: 'absolute',
        left: '0',
        top: '0',
        color,
        font: italic ? 'italic 13px Georgia, serif' : '600 10px "Segoe UI", Arial, sans-serif',
        letterSpacing: italic ? '0.5px' : '3.5px',
        whiteSpace: 'nowrap',
        opacity: '0',
        textShadow: '0 0 12px rgba(0,0,0,0.9)',
        willChange: 'transform, opacity',
      });
      this.labelLayer.appendChild(label);
      this.labels.push(label);
    }
    canvas.parentElement?.insertBefore(this.labelLayer, canvas.nextSibling);

    this.resize();
  }

  resize(): void {
    this.width = Math.max(1, this.canvas.clientWidth);
    this.height = Math.max(1, this.canvas.clientHeight);
    this.maxPixelRatio = this.computeMaxPixelRatio();
    this.pixelRatio = Math.min(this.pixelRatio, this.maxPixelRatio);
    if (this.pixelRatio < this.maxPixelRatio * 0.5) this.pixelRatio = this.maxPixelRatio * 0.5;
    this.applySize();
  }

  move(x: number, y: number): void {
    this.pointer.set(x / this.width - 0.5, y / this.height - 0.5);
  }

  render(time: number, scene: number, local: number, holding: boolean, connection: number): void {
    const dt = Math.max(0, Math.min(time - this.lastTime, 0.05));
    this.lastTime = time;
    this.adaptQuality();
    const reduced = this.reducedMotion;
    const t = reduced ? 2 : time;
    const firstFrame = this.lastScene === -1;
    this.lastScene = scene;

    // ---- scene mix ----
    const o = this.opacity;
    const holeTarget = scene === 0 ? 1 : scene === 1 ? 1 - smooth(1.2, 4.2, local) : 0;
    o.hole = scene === 1 ? holeTarget : damp(o.hole, holeTarget, 3, dt);
    const warpTarget = scene === 1 && !reduced ? smooth(0.6, 2.8, local) * (1 - smooth(11, 12, local) * 0.3) : 0;
    o.warp = damp(o.warp, warpTarget, scene === 1 ? 6 : 1.4, dt);
    o.system = damp(o.system, scene >= 2 && scene <= 4 ? 1 : 0, scene >= 5 ? 5 : 1.1, dt);
    o.heart = damp(o.heart, scene >= 5 ? 1 : 0, 2.5, dt);
    o.warm = damp(o.warm, scene >= 5 ? 1 : 0, 0.8, dt);

    // ---- warp travel ----
    const speedTarget = scene === 1 && !reduced ? smooth(0.4, 3.2, local) * (holding ? 300 : 95) : 0;
    this.speed = damp(this.speed, speedTarget, holding ? 2.2 : 1.4, dt);
    this.travel += this.speed * dt;

    // ---- camera ----
    this.pointerSmooth.lerp(this.pointer, 1 - Math.exp(-3 * dt));
    const shot = this.shot(scene, local, t, holding, connection);
    const rate = reduced ? 8 : scene === 1 && local < 4.5 ? 4 : 1.5;
    this.camPos.x = damp(this.camPos.x, shot.pos.x, rate, dt);
    this.camPos.y = damp(this.camPos.y, shot.pos.y, rate, dt);
    this.camPos.z = damp(this.camPos.z, shot.pos.z, rate, dt);
    this.camLook.x = damp(this.camLook.x, shot.look.x, rate * 1.2, dt);
    this.camLook.y = damp(this.camLook.y, shot.look.y, rate * 1.2, dt);
    this.camLook.z = damp(this.camLook.z, shot.look.z, rate * 1.2, dt);
    this.camFov = damp(this.camFov, shot.fov, 2, dt);
    this.camRoll = damp(this.camRoll, shot.roll, 1.2, dt);
    if (firstFrame) {
      this.camPos.copy(shot.pos);
      this.camLook.copy(shot.look);
      this.camFov = shot.fov;
    }
    const hand = reduced ? 0 : 1;
    this.camera.position.copy(this.camPos);
    this.camera.position.x += (Math.sin(t * 0.37) * 0.12 + Math.sin(t * 0.91) * 0.05) * hand;
    this.camera.position.y += (Math.sin(t * 0.53) * 0.09 + Math.cos(t * 1.27) * 0.03) * hand;
    this.camera.fov = this.camFov;
    this.camera.updateProjectionMatrix();
    this.camera.up.set(Math.sin(this.camRoll), Math.cos(this.camRoll), 0);
    this.camera.lookAt(this.camLook);
    // pointer parallax in camera space
    this.camera.translateX(-this.pointerSmooth.x * 1.4 * hand);
    this.camera.translateY(this.pointerSmooth.y * 0.9 * hand);
    this.camera.updateMatrixWorld();

    // ---- sky ----
    this.skyMesh.position.copy(this.camera.position);
    this.skyMesh.material.uniforms['uWarm'].value = o.warm;
    this.skyMesh.material.uniforms['uBright'].value = 1;
    this.skyStars.position.copy(this.camera.position);
    this.setStarUniforms(this.skyStars, t, 1, 0);
    this.setStarUniforms(this.fieldStars, t, (1 - o.warp * 0.6) * (1 - o.heart * 0.45), 0);
    this.setStarUniforms(this.warpStars, t, o.warp, this.speed * 0.45);
    this.warpStars.material.uniforms['uTravel'].value = this.travel;

    // ---- black hole ----
    this.hole.visible = o.hole > 0.002;
    if (this.hole.visible) {
      const u = this.hole.material.uniforms;
      const toWorld = new Matrix3().setFromMatrix4(this.holeFrame.matrixWorld);
      const toLocal = toWorld.clone().transpose();
      u['uToWorld'].value.copy(toWorld);
      u['uToLocal'].value.copy(toLocal);
      u['uCamLocal'].value.copy(this.camera.position).applyMatrix3(toLocal);
      u['uCamPos'].value.copy(this.camera.position);
      u['uInvViewProj'].value.multiplyMatrices(this.camera.matrixWorld, this.camera.projectionMatrixInverse);
      u['uTime'].value = t;
      u['uOpacity'].value = o.hole;
    }

    // ---- orbit system ----
    this.updateSystem(scene, local, t, dt, connection);

    // ---- heart galaxy ----
    this.heart.visible = o.heart > 0.002;
    if (this.heart.visible) {
      const reveal = scene === 6 || reduced ? 1 : Math.min(1, local / 4.5);
      const beat = reduced ? 0 : Math.pow(Math.max(0, Math.sin(t * 2.2)), 14) * 0.025 + Math.pow(Math.max(0, Math.sin(t * 2.2 - 0.5)), 14) * 0.015;
      const u = this.heartPoints.material.uniforms;
      u['uTime'].value = t;
      u['uReveal'].value = reveal;
      u['uPulse'].value = 1 + beat;
      u['uOpacity'].value = o.heart;
      u['uPixelRatio'].value = this.pixelRatio;
      this.heart.rotation.y = reduced ? 0 : Math.sin(t * 0.16) * 0.38;
      this.heart.rotation.x = reduced ? 0 : Math.sin(t * 0.11) * 0.08;
      this.heartGlow.quaternion.copy(this.camera.quaternion);
      this.heartGlow.position.set(0, 0.4, -0.5);
      this.heartGlow.material.uniforms['uIntensity'].value = o.heart * reveal * (0.28 + beat * 4);
      this.heartGlow.material.uniforms['uTime'].value = t;
    }

    // ---- grade ----
    const flash = scene === 5 && local < 1 && !reduced ? (1 - local) * 0.55 : 0;
    this.grade.uniforms['uFlash'].value = flash;
    this.grade.uniforms['uAspect'].value = this.width / this.height;
    this.bloom.strength = 0.5 + o.heart * 0.25 + o.system * 0.15 * (scene === 4 ? 1 - connection : 1);

    this.composer.render(dt);
    this.updateLabels(scene, local, connection);
  }

  dispose(): void {
    this.canvas.removeEventListener('webglcontextlost', this.onContextLost);
    this.labelLayer.remove();
    this.scene.traverse((object) => {
      const mesh = object as Mesh;
      mesh.geometry?.dispose();
      const material = mesh.material as ShaderMaterial | ShaderMaterial[] | undefined;
      if (Array.isArray(material)) material.forEach((m) => m.dispose());
      else material?.dispose();
    });
    this.skyTarget.dispose();
    this.composer.dispose();
    this.renderer.dispose();
  }

  /* ---------------- camera direction ---------------- */

  private shot(scene: number, local: number, t: number, holding: boolean, connection: number): Shot {
    const aspect = this.width / this.height;
    const framing = aspect < 1.25 ? Math.min(2.4, Math.max(1, 1.4 / aspect)) : 1;
    const pos = new Vector3();
    const look = new Vector3();
    let fov = 38;
    let roll = 0;
    if (scene === 0) {
      const az = -0.35 + Math.sin(t * 0.045) * 0.22;
      pos.set(Math.sin(az) * 36, 3.4, Math.cos(az) * 36);
      look.set(0, -1.6, 0);
      roll = 0.02;
    } else if (scene === 1) {
      const az = -0.35 + Math.sin(t * 0.045) * 0.22;
      const e = Math.pow(Math.min(1, local / 4.2), 2.2);
      const far = new Vector3(Math.sin(az) * 36, 3.4, Math.cos(az) * 36);
      const near = new Vector3(Math.sin(az) * 9, 4.2, Math.cos(az) * 9);
      pos.copy(far).lerp(near, e);
      look.set(0, -1.6 + e * 1.6, 0);
      fov = 38 + smooth(1, 4.5, local) * 22 + (holding ? 14 : 0);
      roll = local > 3 ? (local - 3) * 0.035 : 0;
      if (local > 4.5) {
        // cruising between the stars, then slowing towards the two orbits
        const arrive = smooth(9.5, 12, local);
        pos.copy(near).lerp(new Vector3(0, 12, 32), arrive * 0.6);
        look.set(0, 0, 0);
      }
    } else if (scene >= 2 && scene <= 4) {
      const eu = this.bodyWorld(0, this.tmp);
      const voce = this.bodyWorld(1, this.tmp2);
      if (scene === 2) {
        if (local < 5) {
          look.copy(eu).multiplyScalar(0.55);
          pos.set(-5 + local * 0.3, 7.5, 21);
        } else if (local < 9) {
          look.copy(voce).multiplyScalar(0.55);
          pos.set(5 - (local - 5) * 0.3, 7, 21);
        } else {
          look.set(0, 0, 0);
          pos.set(0, 9.5, 27 + (local - 9) * 0.4);
        }
        fov = 40;
      } else if (scene === 3) {
        const flight = this.reducedMotion ? 0.8 : Math.min(1, local / 3);
        look.set(flight * 3 - 1, 1.6 * (1 - smooth(3, 6, local)), 0);
        pos.set(-3 + local * 0.45, 6.2, 25);
        fov = 42;
      } else {
        const push = Math.max(connection, Math.min(1, local / 16) * 0.4);
        look.set(0, 0, 0);
        pos.set(Math.sin(t * 0.05) * 2, 8 - push * 3.5, 27 - push * 13);
        fov = 40 - connection * 4;
      }
    } else {
      const intro = scene === 5 ? smooth(0, 7, local) : 1;
      const orbit = scene === 6 ? Math.sin(t * 0.06) * 0.35 : Math.sin(t * 0.06) * 0.15;
      const dist = 20 + intro * (scene === 6 ? 30 : 26);
      pos.set(Math.sin(orbit) * dist, 1.5 + (1 - intro) * 2, Math.cos(orbit) * dist);
      look.set(0, scene === 6 ? -3.2 : -1.6, 0);
      fov = 40;
      roll = (1 - intro) * -0.05;
    }
    // portrait screens: step back so the subject still fits
    pos.sub(look).multiplyScalar(framing).add(look);
    return { pos, look, fov, roll };
  }

  /* ---------------- orbit system ---------------- */

  private bodyLocal(index: number, target: Vector3): Vector3 {
    const b = this.orbitAngle + (index === 0 ? Math.PI : 0);
    const conv = this.convergence;
    return target.set(Math.cos(b) * ORBIT_RADIUS * conv, 0, Math.sin(b) * ORBIT_RADIUS * conv);
  }
  private bodyWorld(index: number, target: Vector3): Vector3 {
    this.bodyLocal(index, target);
    return this.system.localToWorld(target);
  }
  private convergence = 1;

  private updateSystem(scene: number, local: number, t: number, dt: number, connection: number): void {
    const o = this.opacity.system;
    this.system.visible = o > 0.002;
    if (!this.system.visible) return;
    if (scene === 4) {
      const target = -0.3 + Math.PI * 2 * Math.round((this.orbitAngle + 0.3) / (Math.PI * 2));
      this.orbitAngle = damp(this.orbitAngle, target, 1.6, dt);
      this.convergence = 1 - connection * 0.92;
      this.trailLength = damp(this.trailLength, 0.5, 1, dt);
    } else if (scene < 4) {
      this.orbitAngle = t * 0.16;
      this.convergence = 1;
      this.trailLength = damp(this.trailLength, 1.1, 2, dt);
    }
    this.system.updateMatrixWorld();
    for (let i = 0; i < 2; i++) {
      const { mesh, corona } = this.bodies[i];
      this.bodyLocal(i, mesh.position);
      mesh.rotation.y = t * 0.2;
      mesh.material.uniforms['uTime'].value = t + i * 10;
      mesh.material.uniforms['uIntensity'].value = o * (scene === 4 ? 1 - connection * 0.3 : 1);
      corona.position.copy(mesh.position);
      corona.quaternion.copy(this.camera.quaternion).premultiply(this.system.quaternion.clone().invert());
      corona.material.uniforms['uIntensity'].value = o * (0.9 + 0.1 * Math.sin(t * 1.7 + i)) * (scene === 4 ? 1 - connection * 0.6 : 1);
      corona.material.uniforms['uTime'].value = t;
    }
    const tu = this.trails.material.uniforms;
    tu['uAngle'].value = this.orbitAngle;
    tu['uConvX'].value = this.convergence;
    tu['uConvZ'].value = this.convergence;
    tu['uLen'].value = this.trailLength;
    tu['uTime'].value = t;
    tu['uOpacity'].value = o;
    tu['uPixelRatio'].value = this.pixelRatio;
    const du = this.dust.material.uniforms;
    du['uTime'].value = t;
    du['uOpacity'].value = o * (scene === 4 ? 1 - connection * 0.5 : 1);
    du['uPixelRatio'].value = this.pixelRatio;

    const bridgeOn = scene === 4 ? 1 : 0;
    const bu = this.bridge.material.uniforms;
    this.bridge.visible = bridgeOn > 0;
    bu['uA'].value.copy(this.bodies[0].mesh.position);
    bu['uB'].value.copy(this.bodies[1].mesh.position);
    bu['uTime'].value = t;
    bu['uConn'].value = connection;
    bu['uOpacity'].value = o * bridgeOn;
    bu['uPixelRatio'].value = this.pixelRatio;
    this.meetGlow.visible = scene === 4 && connection > 0.03;
    this.meetGlow.position.set(0, 0, 0);
    this.meetGlow.quaternion.copy(this.bodies[0].corona.quaternion);
    this.meetGlow.scale.setScalar(0.3 + connection * 0.7);
    this.meetGlow.material.uniforms['uIntensity'].value = o * connection * 0.3 * (connection >= 1 ? 1.15 + Math.sin(t * 2.4) * 0.12 : 1);
    this.meetGlow.material.uniforms['uTime'].value = t;

    // cupid
    const showArrow = scene === 3;
    const flight = this.reducedMotion ? 0.8 : Math.min(1.25, local / 3);
    const arrowFade = showArrow ? o * (1 - smooth(3.2, 4.2, local)) : 0;
    this.arrow.visible = this.arrowGlow.visible = arrowFade > 0.01;
    this.sparks.visible = showArrow;
    if (showArrow) {
      const p = this.arrowPath(flight, this.tmp);
      const ahead = this.arrowPath(flight + 0.01, this.tmp2).sub(p).normalize();
      this.arrow.position.copy(p);
      this.arrow.quaternion.setFromUnitVectors(this.up, ahead);
      for (const m of this.arrowMaterials) m.opacity = arrowFade;
      this.arrowGlow.position.copy(p).addScaledVector(ahead, 1.6);
      this.arrowGlow.quaternion.copy(this.bodies[0].corona.quaternion);
      this.arrowGlow.material.uniforms['uIntensity'].value = arrowFade * 0.9;
      const su = this.sparks.material.uniforms;
      su['uFlight'].value = flight;
      su['uTime'].value = t;
      su['uOpacity'].value = o * (1 - smooth(4, 6, local));
      su['uPixelRatio'].value = this.pixelRatio;
    }
  }

  private arrowPath(f: number, target: Vector3): Vector3 {
    return target
      .copy(this.arrowStart)
      .lerp(this.arrowEnd, f)
      .add(new Vector3(0, Math.sin(Math.min(f, 1.2) * Math.PI) * 3.2, 0));
  }

  private updateLabels(scene: number, local: number, connection: number): void {
    const o = this.opacity.system;
    const showNames = scene >= 2 && scene <= 4 ? o : 0;
    for (let i = 0; i < 2; i++) {
      const label = this.labels[i];
      if (showNames < 0.01) {
        label.style.opacity = '0';
        continue;
      }
      const p = this.bodyWorld(i, this.tmp).project(this.camera);
      const x = (p.x * 0.5 + 0.5) * this.width;
      const y = (-p.y * 0.5 + 0.5) * this.height + 42;
      const merge = scene === 4 ? 1 - smooth(0.7, 1, connection) * 0.6 : 1;
      label.style.opacity = p.z < 1 ? String(showNames * 0.9 * merge) : '0';
      label.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0) translate(-50%, 0)`;
    }
    const miss = this.labels[2];
    const missOn = scene === 3 && local > 3 ? smooth(3, 3.6, local) * o : 0;
    if (missOn > 0.01) {
      const p = this.system.localToWorld(this.tmp.set(0, 3.4, 0)).project(this.camera);
      const x = (p.x * 0.5 + 0.5) * this.width;
      const y = (-p.y * 0.5 + 0.5) * this.height;
      miss.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0) translate(-50%, -50%)`;
    }
    miss.style.opacity = String(missOn);
  }

  /* ---------------- builders ---------------- */

  private createStars(count: number, kind: 'sky' | 'field' | 'warp'): Mesh<InstancedBufferGeometry, ShaderMaterial> {
    const geometry = new InstancedBufferGeometry();
    geometry.setAttribute('position', new Float32BufferAttribute([-1, 0, 0, 1, 0, 0, -1, 1, 0, 1, 1, 0], 3));
    geometry.setIndex([0, 1, 2, 2, 1, 3]);
    const pos = new Float32Array(count * 3);
    const size = new Float32Array(count);
    const color = new Float32Array(count * 3);
    const seed = new Float32Array(count);
    const palette = [
      new Color('#cfdcff'),
      new Color('#ffffff'),
      new Color('#ffe7c9'),
      new Color('#ffc58f'),
      new Color('#9fbcff'),
    ];
    const depth = 320;
    for (let i = 0; i < count; i++) {
      let x = 0;
      let y = 0;
      let z = 0;
      if (kind === 'sky') {
        // denser towards the Milky Way band
        const v = new Vector3(gauss(), gauss(), gauss()).normalize();
        const n = new Vector3(0.32, 1, -0.42).normalize();
        if (Math.random() < 0.45) v.addScaledVector(n, -v.dot(n) * (0.75 + Math.random() * 0.25)).normalize();
        v.multiplyScalar(1500);
        x = v.x;
        y = v.y;
        z = v.z;
      } else if (kind === 'field') {
        const v = new Vector3(gauss(), gauss(), gauss()).normalize();
        v.multiplyScalar(70 + Math.pow(Math.random(), 0.6) * 380);
        x = v.x;
        y = v.y;
        z = v.z;
      } else {
        const a = Math.random() * Math.PI * 2;
        const r = 1.5 + Math.pow(Math.random(), 1.4) * 45;
        x = Math.cos(a) * r;
        y = Math.sin(a) * r;
        z = -Math.random() * depth;
      }
      pos.set([x, y, z], i * 3);
      const bright = Math.pow(Math.random(), kind === 'sky' ? 9 : 5);
      size[i] = (kind === 'sky' ? 1.2 : kind === 'field' ? 1.5 : 1.7) + bright * (kind === 'sky' ? 3.5 : 2.5);
      const c = palette[Math.floor(Math.random() * palette.length)];
      const intensity = (kind === 'sky' ? 0.16 : kind === 'warp' ? 0.3 : 0.16) + bright * (kind === 'sky' ? 3.2 : kind === 'warp' ? 1.5 : 2.2);
      color.set([c.r * intensity, c.g * intensity, c.b * intensity], i * 3);
      seed[i] = Math.random();
    }
    geometry.setAttribute('aPos', new InstancedBufferAttribute(pos, 3));
    geometry.setAttribute('aSize', new InstancedBufferAttribute(size, 1));
    geometry.setAttribute('aColor', new InstancedBufferAttribute(color, 3));
    geometry.setAttribute('aSeed', new InstancedBufferAttribute(seed, 1));
    geometry.instanceCount = count;
    const material = new ShaderMaterial({
      vertexShader: STAR_VERTEX,
      fragmentShader: STAR_FRAGMENT,
      uniforms: {
        uTravel: { value: 0 },
        uDepth: { value: depth },
        uStreak: { value: 0 },
        uPixelRatio: { value: 1 },
        uTime: { value: 0 },
        uOpacity: { value: 1 },
        uWrap: { value: kind === 'warp' ? 1 : 0 },
        uAtten: { value: kind === 'sky' ? 0 : 1 },
        uResolution: { value: new Vector2(1, 1) },
      },
      side: DoubleSide,
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
    });
    const mesh = new Mesh(geometry, material);
    mesh.frustumCulled = false;
    return mesh;
  }

  private setStarUniforms(mesh: Mesh<InstancedBufferGeometry, ShaderMaterial>, t: number, opacity: number, streak: number): void {
    const u = mesh.material.uniforms;
    u['uTime'].value = t;
    u['uOpacity'].value = opacity;
    u['uStreak'].value = streak;
    u['uPixelRatio'].value = this.pixelRatio;
    u['uResolution'].value.set(this.width * this.pixelRatio, this.height * this.pixelRatio);
    mesh.visible = opacity > 0.002;
  }

  private createCorona(color: Color, size: number, spikes: number): Mesh<PlaneGeometry, ShaderMaterial> {
    const mesh = new Mesh(
      new PlaneGeometry(size, size),
      new ShaderMaterial({
        vertexShader: CORONA_VERTEX,
        fragmentShader: CORONA_FRAGMENT,
        uniforms: {
          uColor: { value: color },
          uIntensity: { value: 1 },
          uTime: { value: 0 },
          uSpikes: { value: spikes },
        },
        transparent: true,
        depthWrite: false,
        blending: AdditiveBlending,
      }),
    );
    mesh.renderOrder = 5;
    return mesh;
  }

  private createTrails(warm: Color, cool: Color): Points<BufferGeometry, ShaderMaterial> {
    const perSide = 700;
    const geometry = new BufferGeometry();
    const idx = new Float32Array(perSide * 2);
    const side = new Float32Array(perSide * 2);
    const jit = new Float32Array(perSide * 6);
    for (let i = 0; i < perSide * 2; i++) {
      idx[i] = Math.pow((i % perSide) / perSide, 1.25);
      side[i] = i < perSide ? 1 : 0;
      jit.set([gauss() * 0.35, gauss() * 0.2, gauss() * 0.35], i * 3);
    }
    geometry.setAttribute('position', new Float32BufferAttribute(new Float32Array(perSide * 6), 3));
    geometry.setAttribute('aIdx', new Float32BufferAttribute(idx, 1));
    geometry.setAttribute('aSide', new Float32BufferAttribute(side, 1));
    geometry.setAttribute('aJit', new Float32BufferAttribute(jit, 3));
    const points = new Points(
      geometry,
      new ShaderMaterial({
        vertexShader: TRAIL_VERTEX,
        fragmentShader: SPRITE_FRAGMENT,
        uniforms: {
          uAngle: { value: 0 },
          uRadius: { value: ORBIT_RADIUS },
          uConvX: { value: 1 },
          uConvZ: { value: 1 },
          uLen: { value: 1.1 },
          uTime: { value: 0 },
          uPixelRatio: { value: 1 },
          uOpacity: { value: 1 },
          uWarm: { value: warm.clone().multiplyScalar(1.6) },
          uCool: { value: cool.clone().multiplyScalar(1.6) },
        },
        transparent: true,
        depthWrite: false,
        blending: AdditiveBlending,
      }),
    );
    points.frustumCulled = false;
    return points;
  }

  private createDust(): Points<BufferGeometry, ShaderMaterial> {
    const count = 14000;
    const geometry = new BufferGeometry();
    const angle = new Float32Array(count);
    const radius = new Float32Array(count);
    const y = new Float32Array(count);
    const size = new Float32Array(count);
    const color = new Float32Array(count * 3);
    const tones = [new Color('#c9a582'), new Color('#8e7a9e'), new Color('#e8c9a0'), new Color('#6f88a8')];
    for (let i = 0; i < count; i++) {
      const ring = i % 3;
      const diffuse = Math.random() < 0.3;
      angle[i] = Math.random() * Math.PI * 2;
      radius[i] = ORBIT_RADIUS + ring * 1.15 + gauss() * (diffuse ? 1.4 : 0.09) + (ring === 0 ? 0 : 0.2);
      y[i] = gauss() * (diffuse ? 0.35 : 0.03);
      size[i] = diffuse ? 1 + Math.random() * 2.5 : 0.8 + Math.random() * 1.4;
      const c = tones[Math.floor(Math.random() * tones.length)];
      const k = (diffuse ? 0.08 : 0.32 - ring * 0.07) * (0.5 + Math.random());
      color.set([c.r * k, c.g * k, c.b * k], i * 3);
    }
    geometry.setAttribute('position', new Float32BufferAttribute(new Float32Array(count * 3), 3));
    geometry.setAttribute('aAngle', new Float32BufferAttribute(angle, 1));
    geometry.setAttribute('aRadius', new Float32BufferAttribute(radius, 1));
    geometry.setAttribute('aY', new Float32BufferAttribute(y, 1));
    geometry.setAttribute('aSize', new Float32BufferAttribute(size, 1));
    geometry.setAttribute('aColor', new Float32BufferAttribute(color, 3));
    const points = new Points(
      geometry,
      new ShaderMaterial({
        vertexShader: DUST_VERTEX,
        fragmentShader: SPRITE_FRAGMENT,
        uniforms: { uTime: { value: 0 }, uPixelRatio: { value: 1 }, uOpacity: { value: 1 } },
        transparent: true,
        depthWrite: false,
        blending: AdditiveBlending,
      }),
    );
    points.frustumCulled = false;
    return points;
  }

  private createBridge(): Points<BufferGeometry, ShaderMaterial> {
    const count = 900;
    const geometry = new BufferGeometry();
    const u = new Float32Array(count);
    const seed = new Float32Array(count);
    const jit = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      u[i] = Math.random();
      seed[i] = Math.random();
      jit.set([gauss() * 0.5, gauss() * 0.5, gauss() * 0.5], i * 3);
    }
    geometry.setAttribute('position', new Float32BufferAttribute(new Float32Array(count * 3), 3));
    geometry.setAttribute('aU', new Float32BufferAttribute(u, 1));
    geometry.setAttribute('aSeed', new Float32BufferAttribute(seed, 1));
    geometry.setAttribute('aJit', new Float32BufferAttribute(jit, 3));
    const points = new Points(
      geometry,
      new ShaderMaterial({
        vertexShader: BRIDGE_VERTEX,
        fragmentShader: SPRITE_FRAGMENT,
        uniforms: {
          uA: { value: new Vector3() },
          uB: { value: new Vector3() },
          uTime: { value: 0 },
          uConn: { value: 0 },
          uPixelRatio: { value: 1 },
          uOpacity: { value: 0 },
        },
        transparent: true,
        depthWrite: false,
        blending: AdditiveBlending,
      }),
    );
    points.frustumCulled = false;
    return points;
  }

  private createSparks(): Points<BufferGeometry, ShaderMaterial> {
    const count = 500;
    const geometry = new BufferGeometry();
    const idx = new Float32Array(count);
    const jit = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      idx[i] = Math.random();
      jit.set([gauss() * 0.4, gauss() * 0.4, gauss() * 0.4], i * 3);
    }
    geometry.setAttribute('position', new Float32BufferAttribute(new Float32Array(count * 3), 3));
    geometry.setAttribute('aIdx', new Float32BufferAttribute(idx, 1));
    geometry.setAttribute('aJit', new Float32BufferAttribute(jit, 3));
    const points = new Points(
      geometry,
      new ShaderMaterial({
        vertexShader: SPARK_VERTEX,
        fragmentShader: SPRITE_FRAGMENT,
        uniforms: {
          uFlight: { value: 0 },
          uStart: { value: this.arrowStart },
          uEnd: { value: this.arrowEnd },
          uArc: { value: 3.2 },
          uPixelRatio: { value: 1 },
          uOpacity: { value: 1 },
          uTime: { value: 0 },
        },
        transparent: true,
        depthWrite: false,
        blending: AdditiveBlending,
      }),
    );
    points.frustumCulled = false;
    return points;
  }

  private createHeart(): Points<BufferGeometry, ShaderMaterial> {
    const count = 90000;
    const geometry = new BufferGeometry();
    const a = new Float32Array(count);
    const fill = new Float32Array(count);
    const z = new Float32Array(count);
    const size = new Float32Array(count);
    const glow = new Float32Array(count);
    const seed = new Float32Array(count);
    const scatter = new Float32Array(count * 3);
    const color = new Float32Array(count * 3);
    const core = new Color('#fff1dc');
    const gold = new Color('#f8cf96');
    const rose = new Color('#e8857f');
    const blush = new Color('#c45a7a');
    const violet = new Color('#7d5cc4');
    const c = new Color();
    const mode = new Float32Array(count);
    const xy = new Float32Array(count * 2);
    // outline (y up, centred like the shader) and an arc-length table for even spacing
    const outline: [number, number][] = [];
    const arc: number[] = [0];
    for (let k = 0; k <= 720; k++) {
      const t = (k / 720) * Math.PI * 2;
      outline.push([
        16 * Math.sin(t) ** 3,
        13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t) + 2.6,
      ]);
      if (k > 0) {
        const [x0, y0] = outline[k - 1];
        const [x1, y1] = outline[k];
        arc.push(arc[k - 1] + Math.hypot(x1 - x0, y1 - y0));
      }
    }
    const total = arc[arc.length - 1];
    const paramAt = (len: number) => {
      let lo = 0;
      let hi = arc.length - 1;
      while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (arc[mid] < len) lo = mid;
        else hi = mid;
      }
      return ((lo + (len - arc[lo]) / Math.max(1e-6, arc[hi] - arc[lo])) / 720) * Math.PI * 2;
    };
    const inside = (x: number, y: number) => {
      let hit = false;
      for (let k = 0, j = outline.length - 1; k < outline.length; j = k++) {
        const [xi, yi] = outline[k];
        const [xj, yj] = outline[j];
        if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
      }
      return hit;
    };
    const interior = () => {
      for (;;) {
        const x = (Math.random() * 2 - 1) * 16.5;
        const y = -15 + Math.random() * 30;
        if (inside(x, y)) return [x, y];
      }
    };
    for (let i = 0; i < count; i++) {
      const roll = Math.random();
      let f: number;
      let s: number;
      let g: number;
      if (roll < 0.42) {
        // the rim: dense bright stars tracing the heart
        f = 0.9 + gauss() * 0.045;
        s = 1 + Math.random() * 1.6;
        g = 0.32 + Math.random() * 0.3;
      } else if (roll < 0.78) {
        f = Math.sqrt(Math.random());
        s = 0.9 + Math.random() * 1.5;
        g = 0.18 + Math.random() * 0.22;
      } else if (roll < 0.9) {
        // the bulge
        f = 0.05 + Math.pow(Math.random(), 1.6) * 0.4;
        s = 1 + Math.random() * 1.6;
        g = 0.16 + Math.random() * 0.2;
      } else if (roll < 0.985) {
        // nebula haze: big faint puffs
        f = Math.sqrt(Math.random()) * 1.05;
        s = 6 + Math.random() * 12;
        g = 0.025 + Math.random() * 0.03;
      } else {
        // sparkling giants
        f = Math.sqrt(Math.random());
        s = 3 + Math.random() * 3;
        g = 2.5 + Math.random() * 2.5;
      }
      a[i] = paramAt(Math.random() * total);
      if (roll >= 0.42) {
        // body particles: even area sampling; core and bulge pulled inwards
        let [x, y] = interior();
        if (roll >= 0.78 && roll < 0.9) {
          const pull = 0.15 + Math.random() * 0.45;
          x *= pull;
          y = 0.5 + (y - 0.5) * pull;
        }
        mode[i] = 1;
        xy[i * 2] = x;
        xy[i * 2 + 1] = y;
        f = Math.min(1, Math.hypot(x / 16, (y - 0.5) / 15) * 1.15);
      }
      fill[i] = f;
      z[i] = gauss() * 1.4;
      size[i] = s;
      glow[i] = g;
      seed[i] = Math.random();
      const sv = new Vector3(gauss(), gauss() * 0.6, gauss()).normalize().multiplyScalar(18 + Math.random() * 45);
      scatter.set([sv.x, sv.y, sv.z], i * 3);
      if (f < 0.3) c.copy(core).lerp(gold, f / 0.3);
      else if (f < 0.75) c.copy(gold).lerp(rose, (f - 0.3) / 0.45);
      else c.copy(rose).lerp(blush, Math.min(1, (f - 0.75) / 0.3));
      if (s > 5.5) c.lerp(violet, 0.35 + Math.random() * 0.3);
      if (Math.random() < 0.08) c.lerp(new Color('#ffffff'), 0.6);
      color.set([c.r, c.g, c.b], i * 3);
    }
    geometry.setAttribute('position', new Float32BufferAttribute(new Float32Array(count * 3), 3));
    geometry.setAttribute('aA', new Float32BufferAttribute(a, 1));
    geometry.setAttribute('aMode', new Float32BufferAttribute(mode, 1));
    geometry.setAttribute('aXY', new Float32BufferAttribute(xy, 2));
    geometry.setAttribute('aFill', new Float32BufferAttribute(fill, 1));
    geometry.setAttribute('aZ', new Float32BufferAttribute(z, 1));
    geometry.setAttribute('aSize', new Float32BufferAttribute(size, 1));
    geometry.setAttribute('aGlow', new Float32BufferAttribute(glow, 1));
    geometry.setAttribute('aSeed', new Float32BufferAttribute(seed, 1));
    geometry.setAttribute('aScatter', new Float32BufferAttribute(scatter, 3));
    geometry.setAttribute('aColor', new Float32BufferAttribute(color, 3));
    const points = new Points(
      geometry,
      new ShaderMaterial({
        vertexShader: HEART_VERTEX,
        fragmentShader: SPRITE_FRAGMENT,
        uniforms: {
          uTime: { value: 0 },
          uReveal: { value: 0 },
          uPulse: { value: 1 },
          uPixelRatio: { value: 1 },
          uOpacity: { value: 0 },
        },
        transparent: true,
        depthWrite: false,
        blending: AdditiveBlending,
      }),
    );
    points.frustumCulled = false;
    return points;
  }

  /* ---------------- resolution management ---------------- */

  private computeMaxPixelRatio(): number {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    // never render more than ~4K worth of pixels
    const budget = 3840 * 2160 * 1.05;
    const cssPixels = Math.max(1, this.canvas.clientWidth * this.canvas.clientHeight);
    return Math.max(0.5, Math.min(dpr, Math.sqrt(budget / cssPixels)));
  }

  private applySize(): void {
    this.renderer.setPixelRatio(this.pixelRatio);
    this.renderer.setSize(this.width, this.height, false);
    this.composer.setPixelRatio(this.pixelRatio);
    this.composer.setSize(this.width, this.height);
    this.camera.aspect = this.width / this.height;
    this.camera.updateProjectionMatrix();
  }

  /** Keeps the frame time near 60fps by trading resolution, never smoothness. */
  private adaptQuality(): void {
    const now = performance.now();
    if (this.lastFrame) {
      const ms = Math.min(100, now - this.lastFrame);
      this.frameMs += (ms - this.frameMs) * 0.05;
      this.qualityTimer += ms;
    }
    this.lastFrame = now;
    if (this.qualityTimer < 1200) return;
    this.qualityTimer = 0;
    const floor = Math.max(0.6, this.maxPixelRatio * 0.5);
    if (this.frameMs > 20 && this.pixelRatio > floor) {
      this.pixelRatio = Math.max(floor, this.pixelRatio * 0.85);
      this.goodTime = 0;
      this.applySize();
    } else if (this.frameMs < 17.6 && this.pixelRatio < this.maxPixelRatio) {
      this.goodTime += 1;
      if (this.goodTime >= 3) {
        this.pixelRatio = Math.min(this.maxPixelRatio, this.pixelRatio * 1.1);
        this.goodTime = 0;
        this.applySize();
      }
    } else {
      this.goodTime = 0;
    }
  }
}
