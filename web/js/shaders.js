// GLSL for the develop pipeline. Everything runs in linear light; tone
// controls work on log2 luminance around middle grey so they behave like
// photographic stops, and colors keep their ratios when brightness changes.

export const MAX_MASKS = 8;

export const VERTEX_SHADER = `#version 300 es
in vec2 aPos;
uniform vec2 uViewScale;
uniform vec2 uViewOffset;
uniform bool uFlipY;
out vec2 vFrame;
void main() {
  vec2 p = aPos * 0.5;
  p.y = uFlipY ? p.y : -p.y;
  vFrame = p * uViewScale + uViewOffset;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

export const FRAGMENT_SHADER = `#version 300 es
precision highp float;
#define MAX_MASKS ${MAX_MASKS}

in vec2 vFrame;
out vec4 outColor;

uniform sampler2D uImage;
uniform vec2 uImageSize;
uniform mat3 uFrameToUv;
uniform bool uDimOutside;
uniform vec3 uBackground;

uniform bool uCameraSpace;
uniform vec3 uGains;
uniform mat3 uRgbCam;
uniform bool uRawLook;

uniform float uExposure;
uniform float uContrast;
uniform float uHighlights;
uniform float uShadows;
uniform float uWhites;
uniform float uBlacks;
uniform float uVibrance;
uniform float uSaturation;

uniform int uMaskCount;
uniform vec4 uMaskLine[MAX_MASKS];
uniform vec4 uMaskTone[MAX_MASKS];
uniform vec4 uMaskColor[MAX_MASKS];
uniform int uOverlayMask;

const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);
const float GREY = 0.18;

float bump(float x, float center, float width) {
  float d = (x - center) / width;
  return exp(-d * d);
}

float maskWeight(int i, vec2 p) {
  vec2 a = uMaskLine[i].xy;
  vec2 d = uMaskLine[i].zw - a;
  float len2 = max(dot(d, d), 1e-6);
  float t = dot(p - a, d) / len2;
  return 1.0 - smoothstep(0.0, 1.0, t);
}

vec3 tone(vec3 c, float contrast, float highlights, float shadows) {
  float y = dot(c, LUMA);
  if (y <= 1e-7) return c;
  float ev = log2(y / GREY);
  float base = ev;

  if (uRawLook) ev *= 1.12;
  ev *= 1.0 + 0.5 * contrast;

  float hw = ev > 1.6 ? 1.0 : bump(ev, 1.6, 1.4);
  ev += highlights * 1.1 * hw;
  ev += shadows * 1.3 * bump(ev, -2.6, 1.6);
  ev += uWhites * 0.6 * smoothstep(0.2, 2.4, base);
  ev += uBlacks * 1.0 * (1.0 - smoothstep(-6.0, -2.5, base));

  float y2 = GREY * exp2(ev);
  if (uRawLook && y2 > 0.75) {
    y2 = 0.75 + 0.25 * tanh((y2 - 0.75) / 0.25);
  }
  return c * (y2 / y);
}

vec3 saturate3(vec3 c, float vibrance, float saturation) {
  float y = dot(c, LUMA);
  float mx = max(c.r, max(c.g, c.b));
  float mn = min(c.r, min(c.g, c.b));
  float sat = mx > 1e-6 ? (mx - mn) / mx : 0.0;
  float amount = 1.0 + saturation + vibrance * (1.0 - sat);
  return max(vec3(y) + (c - vec3(y)) * amount, 0.0);
}

vec3 rolloff(vec3 c) {
  float m = max(c.r, max(c.g, c.b));
  if (m <= 1.0) return c;
  return mix(c / m, vec3(1.0), clamp(m - 1.0, 0.0, 1.0));
}

vec3 encodeSrgb(vec3 c) {
  c = clamp(c, 0.0, 1.0);
  vec3 lo = c * 12.92;
  vec3 hi = 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055;
  return mix(lo, hi, step(vec3(0.0031308), c));
}

void main() {
  vec2 uv = (uFrameToUv * vec3(vFrame, 1.0)).xy;
  if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) {
    outColor = vec4(uBackground, 1.0);
    return;
  }

  vec3 c = texture(uImage, uv).rgb;
  if (uCameraSpace) {
    c = min(c * uGains, vec3(1.0));
    c = uRgbCam * c;
  } else {
    c *= uGains;
  }
  c = max(c, 0.0);

  vec2 p = uv * uImageSize;
  float exposure = uExposure;
  float contrast = uContrast;
  float highlights = uHighlights;
  float shadows = uShadows;
  float saturation = uSaturation;
  vec3 localGain = vec3(1.0);
  float overlay = 0.0;
  for (int i = 0; i < MAX_MASKS; i++) {
    if (i >= uMaskCount) break;
    float w = maskWeight(i, p);
    exposure += w * uMaskTone[i].x;
    contrast += w * uMaskTone[i].y;
    highlights += w * uMaskTone[i].z;
    shadows += w * uMaskTone[i].w;
    localGain *= mix(vec3(1.0), uMaskColor[i].rgb, w);
    saturation += w * uMaskColor[i].a;
    if (i == uOverlayMask) overlay = w;
  }

  c *= localGain;
  c *= exp2(exposure);
  c = tone(c, contrast, highlights, shadows);
  c = saturate3(c, uVibrance, saturation);
  c = rolloff(c);
  vec3 srgb = encodeSrgb(c);

  if (overlay > 0.0) srgb = mix(srgb, vec3(1.0, 0.18, 0.22), overlay * 0.5);
  bool outside = abs(vFrame.x) > 0.5 || abs(vFrame.y) > 0.5;
  if (outside && uDimOutside) srgb *= 0.32;
  outColor = vec4(srgb, 1.0);
}`;
