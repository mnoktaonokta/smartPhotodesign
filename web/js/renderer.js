// WebGL2 renderer for the develop pipeline: on-screen drawing and offscreen
// rendering to pixels for matching and export.

import { FRAGMENT_SHADER, MAX_MASKS, VERTEX_SHADER } from "./shaders.js";

const STRIP_HEIGHT = 1024;

export class Renderer {
  constructor(canvas) {
    const gl = canvas.getContext("webgl2", { antialias: false, premultipliedAlpha: false });
    if (!gl) throw new Error("Bu tarayıcı WebGL2 desteklemiyor. Güncel Chrome, Edge veya Safari kullanın.");
    this.canvas = canvas;
    this.gl = gl;
    this.program = link(gl, VERTEX_SHADER, FRAGMENT_SHADER);
    this.uniforms = {};
    const count = gl.getProgramParameter(this.program, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < count; i++) {
      const info = gl.getActiveUniform(this.program, i);
      const name = info.name.replace(/\[0\]$/, "");
      this.uniforms[name] = gl.getUniformLocation(this.program, info.name);
    }
    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(this.program, "aPos");
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    this.maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    this._emptyMaskArray = this._createEmptyMaskArray();
  }

  /** Upload linear half-float RGB pixels. */
  createTexture(width, height, halfFloats) {
    const gl = this.gl;
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB16F, width, height, 0, gl.RGB, gl.HALF_FLOAT, halfFloats);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return texture;
  }

  updateTexture(texture, width, height, halfFloats) {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, width, height, gl.RGB, gl.HALF_FLOAT, halfFloats);
  }

  deleteTexture(texture) {
    if (texture) this.gl.deleteTexture(texture);
  }

  /** R8 texture array with MAX_MASKS layers for brush/subject masks. */
  createMaskArray(width, height) {
    const gl = this.gl;
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, texture);
    gl.texImage3D(gl.TEXTURE_2D_ARRAY, 0, gl.R8, width, height, MAX_MASKS, 0, gl.RED, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return { texture, width, height };
  }

  updateMaskLayer(maskArray, layer, bytes) {
    if (!maskArray) return;
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, maskArray.texture);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texSubImage3D(
      gl.TEXTURE_2D_ARRAY,
      0,
      0,
      0,
      layer,
      maskArray.width,
      maskArray.height,
      1,
      gl.RED,
      gl.UNSIGNED_BYTE,
      bytes,
    );
  }

  clearMaskLayer(maskArray, layer) {
    if (!maskArray) return;
    this.updateMaskLayer(maskArray, layer, new Uint8Array(maskArray.width * maskArray.height));
  }

  deleteMaskArray(maskArray) {
    if (maskArray?.texture) this.gl.deleteTexture(maskArray.texture);
  }

  _createEmptyMaskArray() {
    const gl = this.gl;
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, texture);
    gl.texImage3D(gl.TEXTURE_2D_ARRAY, 0, gl.R8, 1, 1, MAX_MASKS, 0, gl.RED, gl.UNSIGNED_BYTE, new Uint8Array(MAX_MASKS));
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    return texture;
  }

  resize() {
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(this.canvas.clientWidth * dpr));
    const h = Math.max(1, Math.round(this.canvas.clientHeight * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    return { width: w, height: h, dpr };
  }

  clear(rgb) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.disable(gl.SCISSOR_TEST);
    gl.clearColor(rgb[0], rgb[1], rgb[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  /**
   * Draw ``job`` into a canvas-pixel rectangle. ``view.scale``/``view.offset``
   * map the rectangle to frame coordinates (frame = -0.5..0.5).
   */
  drawToCanvas(job, viewport, view, scissor = null) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(viewport.x, this.canvas.height - viewport.y - viewport.h, viewport.w, viewport.h);
    if (scissor) {
      gl.enable(gl.SCISSOR_TEST);
      gl.scissor(scissor.x, this.canvas.height - scissor.y - scissor.h, scissor.w, scissor.h);
    } else {
      gl.disable(gl.SCISSOR_TEST);
    }
    this._draw(job, view, false);
    gl.disable(gl.SCISSOR_TEST);
  }

  /** Render exactly the frame at ``width`` x ``height`` and return top-down RGBA8 pixels. */
  renderPixels(job, width, height) {
    const gl = this.gl;
    const stripH = Math.min(height, STRIP_HEIGHT, this.maxTextureSize);
    const target = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, target);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, stripH, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, target, 0);
    gl.disable(gl.SCISSOR_TEST);

    const out = new Uint8Array(width * height * 4);
    const strip = new Uint8Array(width * stripH * 4);
    for (let y0 = 0; y0 < height; y0 += stripH) {
      const h = Math.min(stripH, height - y0);
      gl.viewport(0, 0, width, h);
      const top = -0.5 + y0 / height;
      const view = { scale: [1, h / height], offset: [0, top + h / height / 2] };
      this._draw(job, view, true);
      gl.readPixels(0, 0, width, h, gl.RGBA, gl.UNSIGNED_BYTE, strip);
      out.set(strip.subarray(0, width * h * 4), y0 * width * 4);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.deleteFramebuffer(fbo);
    gl.deleteTexture(target);
    return out;
  }

  _draw(job, view, flipY) {
    const gl = this.gl;
    const u = this.uniforms;
    gl.useProgram(this.program);
    gl.bindVertexArray(this.vao);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, job.texture);
    gl.uniform1i(u.uImage, 0);
    gl.activeTexture(gl.TEXTURE1);
    const maskTex = job.maskArray?.texture || this._emptyMaskArray;
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, maskTex);
    gl.uniform1i(u.uMaskMaps, 1);
    gl.uniform1i(u.uHasMaskMaps, job.maskArray ? 1 : 0);
    gl.uniform2f(u.uViewScale, view.scale[0], view.scale[1]);
    gl.uniform2f(u.uViewOffset, view.offset[0], view.offset[1]);
    gl.uniform1i(u.uFlipY, flipY ? 1 : 0);
    gl.uniform1i(u.uDimOutside, view.dimOutside ? 1 : 0);
    gl.uniform3fv(u.uBackground, view.background || [0.11, 0.11, 0.12]);
    gl.uniform2f(u.uImageSize, job.imageSize[0], job.imageSize[1]);
    gl.uniformMatrix3fv(u.uFrameToUv, false, job.frameToUv);
    gl.uniform1i(u.uCameraSpace, job.cameraSpace ? 1 : 0);
    gl.uniform3fv(u.uGains, job.gains);
    gl.uniformMatrix3fv(u.uRgbCam, false, job.rgbCam);
    gl.uniform1i(u.uRawLook, job.rawLook ? 1 : 0);
    gl.uniform1f(u.uExposure, job.exposure);
    gl.uniform1f(u.uContrast, job.contrast);
    gl.uniform1f(u.uHighlights, job.highlights);
    gl.uniform1f(u.uShadows, job.shadows);
    gl.uniform1f(u.uWhites, job.whites);
    gl.uniform1f(u.uBlacks, job.blacks);
    gl.uniform1f(u.uVibrance, job.vibrance);
    gl.uniform1f(u.uSaturation, job.saturation);
    const masks = job.masks.slice(0, MAX_MASKS);
    gl.uniform1i(u.uMaskCount, masks.length);
    const types = new Int32Array(MAX_MASKS);
    const inverts = new Int32Array(MAX_MASKS);
    const lines = new Float32Array(MAX_MASKS * 4);
    const tones = new Float32Array(MAX_MASKS * 4);
    const colors = new Float32Array(MAX_MASKS * 4);
    masks.forEach((m, i) => {
      types[i] = m.type || 0;
      inverts[i] = m.invert ? 1 : 0;
      lines.set(m.line, i * 4);
      tones.set(m.tone, i * 4);
      colors.set(m.color, i * 4);
    });
    gl.uniform1iv(u.uMaskType, types);
    gl.uniform1iv(u.uMaskInvert, inverts);
    gl.uniform4fv(u.uMaskLine, lines);
    gl.uniform4fv(u.uMaskTone, tones);
    gl.uniform4fv(u.uMaskColor, colors);
    gl.uniform1i(u.uOverlayMask, job.overlayMask ?? -1);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }
}

function compile(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    throw new Error(`Shader derlenemedi: ${gl.getShaderInfoLog(shader)}`);
  }
  return shader;
}

function link(gl, vs, fs) {
  const program = gl.createProgram();
  gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, vs));
  gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(`Shader bağlanamadı: ${gl.getProgramInfoLog(program)}`);
  }
  return program;
}
