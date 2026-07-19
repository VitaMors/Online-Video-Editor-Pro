import { effectNumberValue, effectStaticValue } from "./effects";
import type { Effect } from "../types/editor";

type ShaderRuntime = {
  canvas: HTMLCanvasElement;
  gl: WebGLRenderingContext;
  program: WebGLProgram;
  texture: WebGLTexture;
  positionBuffer: WebGLBuffer;
  uniforms: Record<string, WebGLUniformLocation | null>;
};

let runtime: ShaderRuntime | null = null;

const vertexShaderSource = `
attribute vec2 a_position;
varying vec2 v_uv;

void main() {
  v_uv = (a_position + 1.0) * 0.5;
  gl_Position = vec4(a_position, 0.0, 1.0);
}
`;

const fragmentShaderSource = `
precision highp float;

uniform sampler2D u_image;
uniform vec2 u_resolution;
uniform float u_mix;
uniform float u_temperature;
uniform float u_tint;
uniform float u_exposure;
uniform float u_contrast;
uniform float u_brightness;
uniform float u_shadowLift;
uniform float u_midtoneGamma;
uniform float u_highlightGain;
uniform vec3 u_masterHsl;
uniform vec3 u_hslRed;
uniform vec3 u_hslYellow;
uniform vec3 u_hslGreen;
uniform vec3 u_hslCyan;
uniform vec3 u_hslBlue;
uniform vec3 u_hslMagenta;
uniform vec3 u_curveRed;
uniform vec3 u_curveGreen;
uniform vec3 u_curveBlue;
uniform vec3 u_curveSaturation;
uniform int u_qualifierEnabled;
uniform float u_qualifierHue;
uniform float u_qualifierHueWidth;
uniform float u_qualifierSatMin;
uniform float u_qualifierSatMax;
uniform float u_qualifierLumMin;
uniform float u_qualifierLumMax;
uniform int u_clippingWarning;
uniform int u_scopeMode;
uniform int u_inputSpace;

varying vec2 v_uv;

float luminance(vec3 rgb) {
  return dot(rgb, vec3(0.2126, 0.7152, 0.0722));
}

vec3 rec2020ToRec709(vec3 c) {
  mat3 m = mat3(
     1.6605, -0.5876, -0.0728,
    -0.1246,  1.1329, -0.0083,
    -0.0182, -0.1006,  1.1187
  );
  return m * c;
}

vec3 decodeInput(vec3 c) {
  if (u_inputSpace == 1) return rec2020ToRec709(c);
  if (u_inputSpace == 2) return pow(max(c, vec3(0.0)), vec3(2.2));
  return c;
}

float hueToRgb(float p, float q, float t) {
  if (t < 0.0) t += 1.0;
  if (t > 1.0) t -= 1.0;
  if (t < 1.0 / 6.0) return p + (q - p) * 6.0 * t;
  if (t < 1.0 / 2.0) return q;
  if (t < 2.0 / 3.0) return p + (q - p) * (2.0 / 3.0 - t) * 6.0;
  return p;
}

vec3 rgbToHsl(vec3 c) {
  float maxc = max(c.r, max(c.g, c.b));
  float minc = min(c.r, min(c.g, c.b));
  float h = 0.0;
  float s = 0.0;
  float l = (maxc + minc) * 0.5;
  float d = maxc - minc;

  if (d > 0.00001) {
    s = d / max(0.00001, 1.0 - abs(2.0 * l - 1.0));
    if (maxc == c.r) h = mod((c.g - c.b) / d, 6.0);
    else if (maxc == c.g) h = (c.b - c.r) / d + 2.0;
    else h = (c.r - c.g) / d + 4.0;
    h /= 6.0;
    if (h < 0.0) h += 1.0;
  }

  return vec3(h, s, l);
}

vec3 hslToRgb(vec3 hsl) {
  float h = fract(hsl.x);
  float s = max(0.0, hsl.y);
  float l = hsl.z;
  if (s <= 0.00001) return vec3(l);
  float q = l < 0.5 ? l * (1.0 + s) : l + s - l * s;
  float p = 2.0 * l - q;
  return vec3(
    hueToRgb(p, q, h + 1.0 / 3.0),
    hueToRgb(p, q, h),
    hueToRgb(p, q, h - 1.0 / 3.0)
  );
}

float hueDistance(float a, float b) {
  float d = abs(a - b);
  return min(d, 360.0 - d);
}

vec3 applyHueSector(vec3 hsl, float center, vec3 adjustment) {
  float h = hsl.x * 360.0;
  float weight = 1.0 - smoothstep(28.0, 62.0, hueDistance(h, center));
  hsl.x = fract(hsl.x + adjustment.x / 360.0 * weight);
  hsl.y = max(0.0, hsl.y * (1.0 + adjustment.y / 100.0 * weight));
  hsl.z += adjustment.z / 100.0 * weight;
  return hsl;
}

float bandValue(vec3 values, float lum) {
  float shadows = 1.0 - smoothstep(0.05, 0.55, lum);
  float mids = smoothstep(0.05, 0.5, lum) * (1.0 - smoothstep(0.5, 0.95, lum));
  float highs = smoothstep(0.45, 1.0, lum);
  return (values.x * shadows + values.y * mids + values.z * highs) / 100.0;
}

float qualifierMask(vec3 hsl) {
  if (u_qualifierEnabled == 0) return 1.0;
  float hueWidth = max(0.5, u_qualifierHueWidth);
  float hueMask = 1.0 - smoothstep(hueWidth, hueWidth + 8.0, hueDistance(hsl.x * 360.0, u_qualifierHue));
  float satMask = smoothstep(u_qualifierSatMin, u_qualifierSatMin + 0.04, hsl.y) * (1.0 - smoothstep(u_qualifierSatMax, u_qualifierSatMax + 0.04, hsl.y));
  float lumMask = smoothstep(u_qualifierLumMin, u_qualifierLumMin + 0.04, hsl.z) * (1.0 - smoothstep(u_qualifierLumMax, u_qualifierLumMax + 0.04, hsl.z));
  return clamp(hueMask * satMask * lumMask, 0.0, 1.0);
}

vec3 applyGrade(vec3 original) {
  vec3 rgb = decodeInput(original);
  vec3 baseHsl = rgbToHsl(clamp(rgb, 0.0, 1.0));
  float mask = qualifierMask(baseHsl);

  vec3 corrected = rgb;
  float temp = u_temperature / 100.0;
  float tint = u_tint / 100.0;
  corrected *= vec3(1.0 + temp * 0.18 + tint * 0.06, 1.0 - tint * 0.14, 1.0 - temp * 0.18 + tint * 0.06);
  corrected = corrected * pow(2.0, u_exposure) + vec3(u_brightness);
  corrected = (corrected - 0.5) * max(0.01, u_contrast) + 0.5;

  float lum = luminance(clamp(corrected, 0.0, 1.0));
  float shadows = 1.0 - smoothstep(0.05, 0.55, lum);
  float mids = smoothstep(0.05, 0.5, lum) * (1.0 - smoothstep(0.5, 0.95, lum));
  float highs = smoothstep(0.45, 1.0, lum);
  corrected += vec3(u_shadowLift * shadows);
  corrected = mix(corrected, pow(max(corrected, vec3(0.0)), vec3(1.0 / max(0.05, u_midtoneGamma))), mids);
  corrected += corrected * u_highlightGain * highs;

  lum = luminance(clamp(corrected, 0.0, 1.0));
  corrected.r += bandValue(u_curveRed, lum);
  corrected.g += bandValue(u_curveGreen, lum);
  corrected.b += bandValue(u_curveBlue, lum);

  vec3 hsl = rgbToHsl(clamp(corrected, 0.0, 1.0));
  hsl.x = fract(hsl.x + u_masterHsl.x / 360.0);
  hsl.y = max(0.0, hsl.y * (1.0 + u_masterHsl.y / 100.0));
  hsl.z += u_masterHsl.z / 100.0;
  hsl = applyHueSector(hsl, 0.0, u_hslRed);
  hsl = applyHueSector(hsl, 60.0, u_hslYellow);
  hsl = applyHueSector(hsl, 120.0, u_hslGreen);
  hsl = applyHueSector(hsl, 180.0, u_hslCyan);
  hsl = applyHueSector(hsl, 240.0, u_hslBlue);
  hsl = applyHueSector(hsl, 300.0, u_hslMagenta);
  hsl.y = max(0.0, hsl.y + bandValue(u_curveSaturation, lum));
  corrected = hslToRgb(hsl);

  return mix(rgb, corrected, mask);
}

vec3 scopeWaveform(vec2 uv) {
  float target = 1.0 - uv.y;
  float glow = 0.0;
  for (int i = 0; i < 48; i++) {
    float sampleY = (float(i) + 0.5) / 48.0;
    vec3 sampleRgb = decodeInput(texture2D(u_image, vec2(uv.x, sampleY)).rgb);
    float lum = luminance(clamp(sampleRgb, 0.0, 1.0));
    glow += 1.0 - smoothstep(0.0, 0.018, abs(target - lum));
  }
  float grid = step(0.985, fract(uv.y * 8.0)) * 0.14 + step(0.99, fract(uv.x * 12.0)) * 0.12;
  return vec3(grid, grid + glow * 0.05, grid + glow * 0.75);
}

vec3 scopeParade(vec2 uv) {
  float third = floor(uv.x * 3.0);
  float localX = fract(uv.x * 3.0);
  float target = 1.0 - uv.y;
  float glow = 0.0;
  for (int i = 0; i < 48; i++) {
    float sampleY = (float(i) + 0.5) / 48.0;
    vec3 sampleRgb = decodeInput(texture2D(u_image, vec2(localX, sampleY)).rgb);
    float value = third < 0.5 ? sampleRgb.r : (third < 1.5 ? sampleRgb.g : sampleRgb.b);
    glow += 1.0 - smoothstep(0.0, 0.018, abs(target - value));
  }
  vec3 color = third < 0.5 ? vec3(1.0, 0.15, 0.1) : (third < 1.5 ? vec3(0.15, 1.0, 0.35) : vec3(0.2, 0.55, 1.0));
  return color * glow * 0.12 + vec3(step(0.99, fract(uv.y * 8.0)) * 0.1);
}

vec3 scopeVectorscope(vec2 uv) {
  vec2 p = uv - 0.5;
  float ring = 1.0 - smoothstep(0.003, 0.012, abs(length(p) - 0.36));
  float axes = (1.0 - smoothstep(0.0, 0.004, abs(p.x))) * 0.18 + (1.0 - smoothstep(0.0, 0.004, abs(p.y))) * 0.18;
  float glow = 0.0;
  for (int y = 0; y < 8; y++) {
    for (int x = 0; x < 8; x++) {
      vec2 sampleUv = vec2((float(x) + 0.5) / 8.0, (float(y) + 0.5) / 8.0);
      vec3 rgb = clamp(decodeInput(texture2D(u_image, sampleUv).rgb), 0.0, 1.0);
      float yv = luminance(rgb);
      vec2 chroma = vec2((rgb.r - yv) * 0.713, (rgb.b - yv) * 0.565) * 1.25;
      glow += 1.0 - smoothstep(0.0, 0.015, length(p - chroma));
    }
  }
  return vec3(axes + ring * 0.18 + glow * 0.12, axes + glow * 0.07, axes + ring * 0.28 + glow * 0.16);
}

void main() {
  vec4 source = texture2D(u_image, v_uv);

  if (u_scopeMode == 1) {
    gl_FragColor = vec4(scopeWaveform(v_uv), source.a);
    return;
  }
  if (u_scopeMode == 2) {
    gl_FragColor = vec4(scopeVectorscope(v_uv), source.a);
    return;
  }
  if (u_scopeMode == 3) {
    gl_FragColor = vec4(scopeParade(v_uv), source.a);
    return;
  }

  vec3 gradedRaw = applyGrade(source.rgb);
  vec3 mixedRaw = mix(gradedRaw, decodeInput(source.rgb), u_mix);
  vec3 mixed = clamp(mixedRaw, 0.0, 1.0);

  if (u_clippingWarning == 1) {
    float highClip = step(1.0, max(mixedRaw.r, max(mixedRaw.g, mixedRaw.b)));
    float lowClip = step(min(mixedRaw.r, min(mixedRaw.g, mixedRaw.b)), 0.0);
    float zebra = step(0.5, fract((gl_FragCoord.x + gl_FragCoord.y) * 0.08));
    vec3 highColor = mix(mixed, vec3(1.0, 0.82, 0.05), zebra * highClip);
    vec3 lowColor = mix(highColor, vec3(0.05, 0.32, 1.0), zebra * lowClip);
    mixed = lowColor;
  }

  gl_FragColor = vec4(mixed, source.a);
}
`;

function compileShader(gl: WebGLRenderingContext, type: number, source: string) {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    console.warn(gl.getShaderInfoLog(shader));
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}

function createRuntime() {
  const canvas = document.createElement("canvas");
  const gl = canvas.getContext("webgl", { alpha: true, premultipliedAlpha: false, preserveDrawingBuffer: true });
  if (!gl) return null;

  const vertexShader = compileShader(gl, gl.VERTEX_SHADER, vertexShaderSource);
  const fragmentShader = compileShader(gl, gl.FRAGMENT_SHADER, fragmentShaderSource);
  if (!vertexShader || !fragmentShader) return null;

  const program = gl.createProgram();
  const texture = gl.createTexture();
  const positionBuffer = gl.createBuffer();
  if (!program || !texture || !positionBuffer) return null;

  gl.attachShader(program, vertexShader);
  gl.attachShader(program, fragmentShader);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    console.warn(gl.getProgramInfoLog(program));
    return null;
  }

  gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

  const uniformNames = [
    "u_image", "u_resolution", "u_mix", "u_temperature", "u_tint", "u_exposure", "u_contrast", "u_brightness",
    "u_shadowLift", "u_midtoneGamma", "u_highlightGain", "u_masterHsl", "u_hslRed", "u_hslYellow", "u_hslGreen",
    "u_hslCyan", "u_hslBlue", "u_hslMagenta", "u_curveRed", "u_curveGreen", "u_curveBlue", "u_curveSaturation",
    "u_qualifierEnabled", "u_qualifierHue", "u_qualifierHueWidth", "u_qualifierSatMin", "u_qualifierSatMax",
    "u_qualifierLumMin", "u_qualifierLumMax", "u_clippingWarning", "u_scopeMode", "u_inputSpace",
  ];
  const uniforms = Object.fromEntries(uniformNames.map((name) => [name, gl.getUniformLocation(program, name)]));

  return { canvas, gl, program, texture, positionBuffer, uniforms } satisfies ShaderRuntime;
}

function shaderRuntime() {
  if (!runtime) runtime = createRuntime();
  return runtime;
}

function numberValue(effect: Effect, key: string, frame: number) {
  return effectNumberValue(effect, key, frame);
}

function boolValue(effect: Effect, key: string) {
  return Boolean(effectStaticValue(effect, key));
}

function setFloat(gl: WebGLRenderingContext, uniforms: ShaderRuntime["uniforms"], key: string, value: number) {
  const location = uniforms[key];
  if (location) gl.uniform1f(location, value);
}

function setInt(gl: WebGLRenderingContext, uniforms: ShaderRuntime["uniforms"], key: string, value: number) {
  const location = uniforms[key];
  if (location) gl.uniform1i(location, value);
}

function setVec3(gl: WebGLRenderingContext, uniforms: ShaderRuntime["uniforms"], key: string, value: [number, number, number]) {
  const location = uniforms[key];
  if (location) gl.uniform3f(location, value[0], value[1], value[2]);
}

function hslAdjust(effect: Effect, prefix: string, frame: number): [number, number, number] {
  return [
    numberValue(effect, `${prefix}Hue`, frame),
    numberValue(effect, `${prefix}Saturation`, frame),
    numberValue(effect, `${prefix}Luminance`, frame),
  ];
}

function curveValues(effect: Effect, prefix: string, frame: number): [number, number, number] {
  return [
    numberValue(effect, `${prefix}Shadows`, frame),
    numberValue(effect, `${prefix}Midtones`, frame),
    numberValue(effect, `${prefix}Highlights`, frame),
  ];
}

export function applyColorGradingShader(source: HTMLCanvasElement, effect: Effect, frame: number) {
  const mix = Math.max(0, Math.min(1, numberValue(effect, "mix", frame) / 100));
  const scopeMode = Math.round(numberValue(effect, "scopeMode", frame));
  if (mix >= 0.999 && scopeMode === 0) return source;

  const current = shaderRuntime();
  if (!current) return source;
  const { canvas, gl, program, texture, positionBuffer, uniforms } = current;
  canvas.width = source.width;
  canvas.height = source.height;

  gl.viewport(0, 0, canvas.width, canvas.height);
  gl.useProgram(program);
  gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
  const positionLocation = gl.getAttribLocation(program, "a_position");
  gl.enableVertexAttribArray(positionLocation);
  gl.vertexAttribPointer(positionLocation, 2, gl.FLOAT, false, 0, 0);

  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);

  setInt(gl, uniforms, "u_image", 0);
  const resolutionLocation = uniforms.u_resolution;
  if (resolutionLocation) gl.uniform2f(resolutionLocation, canvas.width, canvas.height);
  setFloat(gl, uniforms, "u_mix", mix);
  setFloat(gl, uniforms, "u_temperature", numberValue(effect, "temperature", frame));
  setFloat(gl, uniforms, "u_tint", numberValue(effect, "tint", frame));
  setFloat(gl, uniforms, "u_exposure", numberValue(effect, "exposure", frame));
  setFloat(gl, uniforms, "u_contrast", numberValue(effect, "contrast", frame));
  setFloat(gl, uniforms, "u_brightness", numberValue(effect, "brightness", frame));
  setFloat(gl, uniforms, "u_shadowLift", numberValue(effect, "shadowLift", frame));
  setFloat(gl, uniforms, "u_midtoneGamma", numberValue(effect, "midtoneGamma", frame));
  setFloat(gl, uniforms, "u_highlightGain", numberValue(effect, "highlightGain", frame));
  setVec3(gl, uniforms, "u_masterHsl", [numberValue(effect, "masterHue", frame), numberValue(effect, "masterSaturation", frame), numberValue(effect, "masterLuminance", frame)]);
  setVec3(gl, uniforms, "u_hslRed", hslAdjust(effect, "red", frame));
  setVec3(gl, uniforms, "u_hslYellow", hslAdjust(effect, "yellow", frame));
  setVec3(gl, uniforms, "u_hslGreen", hslAdjust(effect, "green", frame));
  setVec3(gl, uniforms, "u_hslCyan", hslAdjust(effect, "cyan", frame));
  setVec3(gl, uniforms, "u_hslBlue", hslAdjust(effect, "blue", frame));
  setVec3(gl, uniforms, "u_hslMagenta", hslAdjust(effect, "magenta", frame));
  setVec3(gl, uniforms, "u_curveRed", curveValues(effect, "redCurve", frame));
  setVec3(gl, uniforms, "u_curveGreen", curveValues(effect, "greenCurve", frame));
  setVec3(gl, uniforms, "u_curveBlue", curveValues(effect, "blueCurve", frame));
  setVec3(gl, uniforms, "u_curveSaturation", curveValues(effect, "saturationCurve", frame));
  setInt(gl, uniforms, "u_qualifierEnabled", boolValue(effect, "qualifierEnabled") ? 1 : 0);
  setFloat(gl, uniforms, "u_qualifierHue", numberValue(effect, "qualifierHue", frame));
  setFloat(gl, uniforms, "u_qualifierHueWidth", numberValue(effect, "qualifierHueWidth", frame));
  setFloat(gl, uniforms, "u_qualifierSatMin", numberValue(effect, "qualifierSatMin", frame) / 100);
  setFloat(gl, uniforms, "u_qualifierSatMax", numberValue(effect, "qualifierSatMax", frame) / 100);
  setFloat(gl, uniforms, "u_qualifierLumMin", numberValue(effect, "qualifierLumMin", frame) / 100);
  setFloat(gl, uniforms, "u_qualifierLumMax", numberValue(effect, "qualifierLumMax", frame) / 100);
  setInt(gl, uniforms, "u_clippingWarning", boolValue(effect, "clippingWarning") ? 1 : 0);
  setInt(gl, uniforms, "u_scopeMode", Math.max(0, Math.min(3, scopeMode)));
  setInt(gl, uniforms, "u_inputSpace", Math.max(0, Math.min(2, Math.round(numberValue(effect, "inputSpace", frame)))));

  gl.drawArrays(gl.TRIANGLES, 0, 6);

  const output = document.createElement("canvas");
  output.width = source.width;
  output.height = source.height;
  const context = output.getContext("2d");
  if (!context) return source;
  context.drawImage(canvas, 0, 0);
  return output;
}