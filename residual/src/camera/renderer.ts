/**
 * WebGL image pipeline for the camera. One pass:
 *   video -> anomaly density (darken + soften, before exposure so it is lit like the scene)
 *         -> exposure -> low-light tone curve -> desaturation / night-vision phosphor
 *         -> luminance-dependent sensor grain -> vignette
 * The anomaly mask is in video-frame coordinates, so it stays registered to the scene
 * whatever crop the screen applies.
 */

const VERT = `
attribute vec2 aPos;
varying vec2 vUv;
void main() {
  vUv = vec2(aPos.x * 0.5 + 0.5, 0.5 - aPos.y * 0.5);
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

const FRAG = `
precision mediump float;
varying vec2 vUv;
uniform sampler2D uVideo;
uniform sampler2D uMask;
uniform vec4 uCrop;
uniform vec2 uTexel;
uniform vec2 uRes;
uniform float uTime;
uniform float uExposure;
uniform float uGrain;
uniform float uSat;
uniform float uNV;
uniform float uMaskOn;
uniform float uMirror;

float hash(vec2 p) {
  p = fract(p * vec2(443.897, 441.423));
  p += dot(p, p.yx + 19.19);
  return fract((p.x + p.y) * p.x);
}
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
}
vec3 tap(vec2 uv) { return texture2D(uVideo, uv).rgb; }

void main() {
  vec2 uv = vUv * uCrop.xy + uCrop.zw;
  if (uMirror > 0.5) uv.x = 1.0 - uv.x;
  vec3 c = tap(uv);

  if (uMaskOn > 0.5) {
    // premultiplied mask: r = shadow-layer opacity, g = body-layer opacity
    vec4 mk = texture2D(uMask, uv);
    float shadowA = mk.r;
    float bodyA = mk.g;
    if (shadowA + bodyA > 0.002) {
      // uneven, slowly drifting density so it reads as something in the scene, not a stamp
      float n = vnoise(uv * vec2(70.0, 52.0) + vec2(uTime * 0.35, -uTime * 0.21));
      shadowA *= 0.78 + 0.36 * n;
      bodyA *= 0.88 + 0.18 * n;
      vec3 soft = (tap(uv + vec2(uTexel.x * 2.0, 0.0)) + tap(uv - vec2(uTexel.x * 2.0, 0.0)) +
                   tap(uv + vec2(0.0, uTexel.y * 2.0)) + tap(uv - vec2(0.0, uTexel.y * 2.0))) * 0.25;
      c = mix(c, soft, clamp((shadowA + bodyA) * 1.5, 0.0, 0.75));
      c *= 1.0 - clamp(shadowA, 0.0, 0.92);
      // a dim object lit by whatever light reaches this spot
      // A dim object: darker than anything moderately lit behind it; where the background is
      // near black, faintly lit instead (it stands nearer the light than the void behind it).
      vec2 w = uTexel * 24.0;
      vec3 around = (tap(uv + vec2(w.x, 0.0)) + tap(uv - vec2(w.x, 0.0)) + tap(uv + vec2(0.0, w.y)) + tap(uv - vec2(0.0, w.y))) * 0.25;
      float illum = dot(around, vec3(0.299, 0.587, 0.114));
      float bgL = dot(soft, vec3(0.299, 0.587, 0.114));
      float bodyL = mix(bgL + 0.05 + 0.22 * illum, bgL * 0.45, smoothstep(0.07, 0.16, bgL));
      c = mix(c, vec3(bodyL) * vec3(0.99, 0.97, 0.95), clamp(bodyA, 0.0, 0.9));
    }
  }

  c *= uExposure;
  // low-light tone curve: lifted toe, soft shoulder
  c = c * (1.0 + c * 0.1) / (1.0 + c * 0.55) * 1.32;
  // crushed blacks, the way small sensors handle a dark room
  c = mix(c, c * c * (3.0 - 2.0 * c), 0.35);
  c = max(c - 0.008, 0.0) * 1.01;
  float l = dot(c, vec3(0.299, 0.587, 0.114));

  if (uNV > 0.5) {
    float g = pow(clamp(l * 1.55, 0.0, 1.4), 0.82);
    vec2 o = uTexel * 3.0;
    float bloom = dot(tap(uv + o) + tap(uv - o) + tap(uv + vec2(o.x, -o.y)) + tap(uv + vec2(-o.x, o.y)), vec3(0.075));
    g += max(0.0, bloom * uExposure - 0.35) * 0.6;
    c = vec3(0.70, 0.86, 0.66) * g;
    l = g;
  } else {
    vec3 cool = vec3(l) * vec3(0.94, 0.98, 1.04);
    c = mix(cool, c, uSat);
  }

  float gain = clamp(uExposure, 0.5, 4.0);
  float grain = hash(vUv * uRes + fract(uTime * 13.17) * 311.0) - 0.5;
  float amount = uGrain * (0.035 + 0.13 * pow(1.0 - clamp(l, 0.0, 1.0), 2.0)) * (0.65 + 0.35 * gain) * (uNV > 0.5 ? 1.5 : 1.0);
  c += grain * amount;
  if (uNV < 0.5) {
    float chroma = hash(vUv * uRes * 0.5 + fract(uTime * 7.31) * 97.0) - 0.5;
    c += vec3(chroma, -chroma * 0.6, chroma * 0.3) * amount * 0.35;
  }

  vec2 d = vUv - 0.5;
  c *= 1.0 - dot(d, d) * (uNV > 0.5 ? 1.5 : 0.85);
  gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
}`;

export interface RenderParams {
  exposure: number;
  grain: number;
  saturation: number;
  nightVision: boolean;
  mirror: boolean;
  time: number;
}

export class CameraRenderer {
  readonly gl: WebGLRenderingContext;
  private prog: WebGLProgram;
  private videoTex: WebGLTexture;
  private maskTex: WebGLTexture;
  private u: Record<string, WebGLUniformLocation | null> = {};
  /** uv scale/offset applied to the video for "cover" fit */
  crop = { sx: 1, sy: 1, ox: 0, oy: 0 };

  constructor(readonly canvas: HTMLCanvasElement) {
    const gl = canvas.getContext('webgl', { alpha: false, antialias: false, preserveDrawingBuffer: true, powerPreference: 'high-performance' });
    if (!gl) throw new Error('WebGL unavailable');
    this.gl = gl;
    const compile = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? 'shader');
      return s;
    };
    const prog = gl.createProgram()!;
    gl.attachShader(prog, compile(gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) ?? 'link');
    this.prog = prog;
    gl.useProgram(prog);

    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, 'aPos');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

    for (const n of ['uVideo', 'uMask', 'uCrop', 'uTexel', 'uRes', 'uTime', 'uExposure', 'uGrain', 'uSat', 'uNV', 'uMaskOn', 'uMirror']) this.u[n] = gl.getUniformLocation(prog, n);

    const tex = () => {
      const t = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 0]));
      return t;
    };
    this.videoTex = tex();
    this.maskTex = tex();
    gl.uniform1i(this.u.uVideo, 0);
    gl.uniform1i(this.u.uMask, 1);
  }

  /** Matches the drawing buffer to the element size (capped for performance) and recomputes the crop. */
  resize(videoW: number, videoH: number): void {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const rect = this.canvas.getBoundingClientRect();
    const maxW = Math.max(videoW, videoH) * 1.25;
    const scale = Math.min(dpr, maxW / Math.max(1, Math.max(rect.width, rect.height)));
    const w = Math.max(2, Math.round(rect.width * scale));
    const h = Math.max(2, Math.round(rect.height * scale));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    const ca = w / h;
    const va = videoW / Math.max(1, videoH);
    if (va > ca) this.crop = { sx: ca / va, sy: 1, ox: (1 - ca / va) / 2, oy: 0 };
    else this.crop = { sx: 1, sy: va / ca, ox: 0, oy: (1 - va / ca) / 2 };
  }

  /** Normalised frame coordinates -> fraction of the canvas element. */
  frameToView(nx: number, ny: number, mirror = false): [number, number] {
    const x = mirror ? 1 - nx : nx;
    return [(x - this.crop.ox) / this.crop.sx, (ny - this.crop.oy) / this.crop.sy];
  }

  render(video: TexImageSource, videoW: number, videoH: number, mask: HTMLCanvasElement | null, p: RenderParams): void {
    const gl = this.gl;
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.useProgram(this.prog);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.videoTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, video);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.maskTex);
    if (mask) {
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, mask);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    }
    gl.uniform4f(this.u.uCrop, this.crop.sx, this.crop.sy, this.crop.ox, this.crop.oy);
    gl.uniform2f(this.u.uTexel, 1 / Math.max(1, videoW), 1 / Math.max(1, videoH));
    gl.uniform2f(this.u.uRes, this.canvas.width, this.canvas.height);
    gl.uniform1f(this.u.uTime, p.time);
    gl.uniform1f(this.u.uExposure, p.exposure);
    gl.uniform1f(this.u.uGrain, p.grain);
    gl.uniform1f(this.u.uSat, p.saturation);
    gl.uniform1f(this.u.uNV, p.nightVision ? 1 : 0);
    gl.uniform1f(this.u.uMaskOn, mask ? 1 : 0);
    gl.uniform1f(this.u.uMirror, p.mirror ? 1 : 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }
}
