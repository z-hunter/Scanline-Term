export type CRTColorMode = 'color' | 'bw' | 'green' | 'amber' | 'blue';

export interface CRTSettings {
  curvature: number; // 0.0 to 1.0 (Approx, was using hardcoded math)
  scanlineCount: number; // 300 - 1000?
  scanlineIntensity: number; // 0.0 to 1.0
  aberration: number; // 0.0 to 10.0 (pixels?)
  vignette: number; // 0.0 to 1.0
  phosphor: number; // 0.0 to 1.0 (Surface noise/lift)
  bezelGlow: boolean; // Optimization toggle
  bloom: number; // 0.0 to 1.0 (Halation intensity)
  glow: number; // 0.0 to 1.0 (Ambient screen glow)
  persistence: number; // 0.0 to 1.0 (Phosphor trail / afterglow)
  persistenceIntensity: number; // 0.0 to 4.0 (Visible phosphor trail intensity)
  beamModulation: number; // 0.0 to 1.0 (Dynamically widens electron beam on bright pixels)
  breathing: number; // 0.0 to 1.0 (High Voltage Anode Breathing / Raster Bloom)
  antiAliasedPixels: boolean; // Anti-Moiré sharp pixel filter (Bandlimited Box Integration)
  colorMode: CRTColorMode;
}

export class CRTFilter {
  canvas: HTMLCanvasElement;
  gl: WebGLRenderingContext | null;
  program: WebGLProgram | null;
  texture: WebGLTexture | null;
  buffer: WebGLBuffer | null;
  positionLocation: number;
  texCoordLocation: number;
  resolutionLocation: WebGLUniformLocation | null;
  sourceResolutionLocation: WebGLUniformLocation | null;
  antiAliasedPixelsLocation: WebGLUniformLocation | null;
  colorModeLocation: WebGLUniformLocation | null;
  timeLocation: WebGLUniformLocation | null;
  scanlineCountLocation: WebGLUniformLocation | null;
  curvatureLocation: WebGLUniformLocation | null;
  aberrationLocation: WebGLUniformLocation | null;
  vignetteLocation: WebGLUniformLocation | null;
  scanlineIntensityLocation: WebGLUniformLocation | null;
  phosphorLocation: WebGLUniformLocation | null;
  bezelGlowLocation: WebGLUniformLocation | null;
  bloomLocation: WebGLUniformLocation | null;
  glowLocation: WebGLUniformLocation | null;
  trailLocation: WebGLUniformLocation | null;
  persistenceLocation: WebGLUniformLocation | null;
  persistenceIntensityLocation: WebGLUniformLocation | null;
  beamModulationLocation: WebGLUniformLocation | null;
  breathingScaleLocation: WebGLUniformLocation | null;
  imageLocation: WebGLUniformLocation | null;

  smoothedExpansion: number = 0;
  lastBreathingTime: number = 0;

  // Accumulation / Persistence resources
  accumProgram: WebGLProgram | null = null;
  accumPosLocation: number = 0;
  accumTexCoordLocation: number = 0;
  accumCurrentTexLocation: WebGLUniformLocation | null = null;
  accumHistoryTexLocation: WebGLUniformLocation | null = null;
  accumPersistenceLocation: WebGLUniformLocation | null = null;

  fboA: WebGLFramebuffer | null = null;
  fboB: WebGLFramebuffer | null = null;
  fboTexA: WebGLTexture | null = null;
  fboTexB: WebGLTexture | null = null;
  fboCurrent: number = 0;
  fboWidth: number = 0;
  fboHeight: number = 0;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.gl =
      canvas.getContext('webgl') ||
      (canvas.getContext('experimental-webgl') as WebGLRenderingContext);

    if (!this.gl) {
      console.error('WebGL not supported');
      this.program = null;
      this.texture = null;
      this.buffer = null;
      this.positionLocation = 0;
      this.texCoordLocation = 0;
      this.resolutionLocation = null;
      this.timeLocation = null;
      this.scanlineCountLocation = null;
      this.curvatureLocation = null;
      this.aberrationLocation = null;
      this.vignetteLocation = null;
      this.scanlineIntensityLocation = null;
      this.phosphorLocation = null;
      this.bezelGlowLocation = null;
      this.bloomLocation = null;
      this.glowLocation = null;
      this.trailLocation = null;
      this.persistenceLocation = null;
      this.persistenceIntensityLocation = null;
      this.beamModulationLocation = null;
      this.breathingScaleLocation = null;
      this.imageLocation = null;
      this.sourceResolutionLocation = null;
      this.antiAliasedPixelsLocation = null;
      this.colorModeLocation = null;
      return;
    }

    this.program = null;
    this.texture = null;
    this.buffer = null;
    this.positionLocation = 0;
    this.texCoordLocation = 0;
    this.resolutionLocation = null;
    this.sourceResolutionLocation = null;
    this.antiAliasedPixelsLocation = null;
    this.timeLocation = null;
    this.scanlineCountLocation = null;
    this.curvatureLocation = null;
    this.aberrationLocation = null;
    this.vignetteLocation = null;
    this.scanlineIntensityLocation = null;
    this.phosphorLocation = null;
    this.bezelGlowLocation = null;
    this.bloomLocation = null;
    this.glowLocation = null;
    this.trailLocation = null;
    this.persistenceLocation = null;
    this.persistenceIntensityLocation = null;
    this.beamModulationLocation = null;
    this.breathingScaleLocation = null;
    this.imageLocation = null;
    this.colorModeLocation = null;

    this.init();
  }

  createShader(gl: WebGLRenderingContext, type: number, source: string): WebGLShader | null {
    const shader = gl.createShader(type);
    if (!shader) return null;
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      console.error(gl.getShaderInfoLog(shader));
      gl.deleteShader(shader);
      return null;
    }
    return shader;
  }

  createProgram(
    gl: WebGLRenderingContext,
    vsSource: string,
    fsSource: string
  ): WebGLProgram | null {
    const vs = this.createShader(gl, gl.VERTEX_SHADER, vsSource);
    const fs = this.createShader(gl, gl.FRAGMENT_SHADER, fsSource);
    if (!vs || !fs) return null;

    const program = gl.createProgram();
    if (!program) return null;

    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      console.error(gl.getProgramInfoLog(program));
      return null;
    }
    return program;
  }

  init(): void {
    if (!this.gl) return;
    const gl = this.gl;
    gl.getExtension('OES_standard_derivatives');

    // Vertex Shader
    const vsSource = `
            attribute vec2 a_position;
            attribute vec2 a_texCoord;
            varying vec2 v_texCoord;
            void main() {
                gl_Position = vec4(a_position, 0.0, 1.0);
                v_texCoord = a_texCoord;
            }
        `;

    // Fragment Shader (The CRT Magic)
    const fsSource = `
            #ifdef GL_OES_standard_derivatives
            #extension GL_OES_standard_derivatives : enable
            #endif
            precision mediump float;
            uniform sampler2D u_image;
            uniform vec2 u_resolution;
            uniform float u_time;
            uniform float u_scanlineCount;
            uniform float u_curvature;
            uniform float u_aberration;
            uniform float u_vignette;
            uniform float u_scanlineIntensity;
            uniform float u_phosphor;
            uniform float u_bezelGlow;
            uniform float u_bloom;
            uniform float u_glow;
            uniform float u_persistence;
            uniform float u_persistenceIntensity;
            uniform float u_beamModulation;
            uniform float u_breathingScale;
            uniform vec2 u_sourceResolution;
            uniform float u_antiAliasedPixels;
            uniform float u_colorMode;
            uniform sampler2D u_trail;
            varying vec2 v_texCoord;

            // Curvature
            vec2 curve(vec2 uv) {
                // If curvature is 0, return uv
                if (u_curvature <= 0.0) return uv; // Small optimization/bypass
                
                // Parameterized:
                // Use u_curvature to scale the distortion
                // u_curvature = 1.0 is "normal" strong distortion.
                
                vec2 center = uv - 0.5;
                float r2 = dot(center, center);
                // Simple pincushion: uv = center * (1.0 + k * r2) + 0.5
                
                // Using the previous "fancy" math but parameterized:
                vec2 uv_t = (uv - 0.5) * 2.0;
                uv_t *= 1.0 + (u_curvature * 0.1); // Zoom out slightly to fit
                
                uv_t.x *= 1.0 + pow((abs(uv_t.y) / 5.0), 2.0) * u_curvature * 5.0;
                uv_t.y *= 1.0 + pow((abs(uv_t.x) / 4.0), 2.0) * u_curvature * 5.0;
                
                uv_t  = (uv_t / 2.0) + 0.5;
                
                // Clip logic moved to main() so we can use "overscan" UVs for glow
                return uv_t;
            }

             // Anti-Moiré Sharp Pixel Reconstruction (Continuous Bandlimited Area Integration)
             vec2 getSmoothUV(vec2 uv) {
                 if (u_antiAliasedPixels <= 0.5) {
                     // Standard Nearest-Neighbor discrete stepping
                     vec2 p = uv * u_sourceResolution;
                     return (floor(p) + 0.5) / u_sourceResolution;
                 }
                 
                 vec2 p = uv * u_sourceResolution;
                 #ifdef GL_OES_standard_derivatives
                 vec2 w = max(fwidth(p), vec2(0.0001));
                 #else
                 vec2 w = max(u_sourceResolution / u_resolution, vec2(0.0001));
                 #endif
                 
                 // Analytical integral of a box filter: flat 100% sharp inside pixel center,
                 // smooth continuous 1-physical-pixel anti-aliased blend exactly at pixel boundaries
                 vec2 p_smooth = floor(p - 0.5) + 0.5 + clamp((fract(p - 0.5) - 0.5 + 0.5 * w) / w, 0.0, 1.0);
                 return p_smooth / u_sourceResolution;
             }

             // Helper to prevent texture wrapping/clamping artifacts
             vec3 sampleScreen(vec2 uv) {
                 vec2 smoothUV = getSmoothUV(uv);
                 vec3 color = texture2D(u_image, smoothUV).rgb;
                 float inBounds = step(0.0, uv.x) * step(uv.x, 1.0) * step(0.0, uv.y) * step(uv.y, 1.0);
                 return color * inBounds;
             }

             void main() {
                 vec2 curvedUV = curve(v_texCoord);

                 // Check invalid/bezel area explicitely (Static bezel and glass curvature geometry)
                 bool isBezel = (curvedUV.x < 0.0 || curvedUV.x > 1.0 || curvedUV.y < 0.0 || curvedUV.y > 1.0);

                 // Screen Surface / Bezel (Gray Background)
                 if (isBezel) {
                      // Smooth Matte Plastic Look
                      vec2 center = v_texCoord - 0.5;
                      float dist = length(center);
                      
                      float grey = 0.1;
                      grey -= dist * 0.05;
                      
                      vec3 finalColor = vec3(grey);

                      // BEZEL GLOW (Single Pass - 16 Tap Spiral Blur)
                      // No FBO. No Multi-Texture. We sample u_image directly.
                      if (u_bezelGlow > 0.5) {
                           // Spiral Blur Logic
                           // Radius: 0.08 (Was 0.05) - Wider blur to support longer reach
                           float maxRadius = 0.08; 
                           
                           vec3 glow = vec3(0.0);
                           float totalWeight = 0.0;
                           
                           // Dither to hide loop artifacts
                           vec3 magic = vec3(0.06711056, 0.00583715, 52.9829189);
                           float dither = fract(magic.z * fract(dot(v_texCoord * u_resolution, magic.xy)));
                           float startAngle = dither * 6.2831853;
                           
                           // 16 Samples
                           for (int i = 0; i < 16; i++) {
                                float r = sqrt(float(i) / 16.0) * maxRadius;
                                float theta = startAngle + float(i) * 2.39996323; // Golden Angle
                                
                                vec2 offset = vec2(cos(theta), sin(theta)) * r;
                                vec2 sourceUV = clamp(curvedUV, 0.01, 0.99);
                                vec2 sampleUV = clamp(sourceUV + offset, 0.01, 0.99);
                                
                                // MASK Edges (Simulate Black Borders on the internal screen)
                                vec2 center = sampleUV - 0.5;
                                vec2 d = abs(center) * 2.0;
                                float mask = 1.0 - step(0.98, max(d.x, d.y));
                                
                                glow += texture2D(u_image, sampleUV).rgb * mask;
                                totalWeight += 1.0;
                           }
                           glow /= totalWeight;
                           
                           // Distance Fade relative to the edge
                           vec2 distVec = max(vec2(0.0), max(0.0 - curvedUV, curvedUV - 1.0));
                           float dist = length(distVec);
                           float fade = 1.0 - smoothstep(0.0, 0.25, dist);
                           
                           // Keep the bezel halo visible even against mostly-black content.
                           glow = max(pow(glow, vec3(1.5)), vec3(0.004, 0.014, 0.007));
                           finalColor += glow * 8.0 * fade;
                      }

                     gl_FragColor = vec4(finalColor, 1.0);
                     return;
                }

                // Internal Electron Raster Space
                // In dark/resting state: narrow black margin inside the bezel (~1.3%)
                // In peak bright state: raster expands outward and creeps 1-2px under the static bezel
                vec2 rasterUV = curvedUV;
                if (u_breathingScale > 0.0) {
                    float baseMargin = 0.015;
                    float rasterScale = 1.0 + (baseMargin * 2.0) - u_breathingScale;
                    rasterUV = (curvedUV - 0.5) * rasterScale + 0.5;
                }

                // Chromatic Aberration
                float offset = u_aberration * 0.005;
                
                float r = sampleScreen(rasterUV + vec2(offset, 0.0)).r;
                float g = sampleScreen(rasterUV).g;
                float b = sampleScreen(rasterUV + vec2(-offset, 0.0)).b;

                vec3 color = vec3(r, g, b);

                // Phosphor Afterglow Trail (Soft, translucent trail overlay)
                if (u_persistence > 0.0) {
                     vec3 trail = texture2D(u_trail, rasterUV).rgb;
                     float inBounds = step(0.0, rasterUV.x) * step(rasterUV.x, 1.0) * step(0.0, rasterUV.y) * step(rasterUV.y, 1.0);
                     color = max(color, trail * inBounds * clamp(u_persistenceIntensity, 0.0, 4.0));
                }

                // BLOOM / HALATION (Smooth phosphor electron bleed on bright highlights)
                if (u_bloom > 0.0) {
                     float bloomRadius = 0.015;
                     vec3 bloomSum = vec3(0.0);
                     float totalWeight = 0.0;
                     
                     vec3 magic = vec3(0.06711056, 0.00583715, 52.9829189);
                     float dither = fract(magic.z * fract(dot(v_texCoord * u_resolution, magic.xy)));
                     float startAngle = dither * 6.28318530718;

                     for (int i = 0; i < 16; i++) {
                          float fi = float(i) + dither;
                          float normDist = sqrt(fi / 16.0);
                          float r = normDist * bloomRadius;
                          float theta = startAngle + float(i) * 2.39996323; 
                          
                          vec2 b_offset = vec2(cos(theta), sin(theta)) * r;
                          b_offset.y *= 0.75;

                          vec3 sample = sampleScreen(rasterUV + b_offset);
                          float luma = dot(sample, vec3(0.2126, 0.7152, 0.0722));
                          float brightPass = smoothstep(0.55, 0.9, luma);

                          float weight = exp(-normDist * normDist * 3.5);
                          bloomSum += sample * brightPass * weight;
                          totalWeight += weight;
                     }
                     bloomSum /= max(totalWeight, 0.001);

                     color += bloomSum * u_bloom * 2.5;
                }

                // Phosphor Surface Simulation (The "Greyish" look)
                if (u_phosphor > 0.0) {
                     // 1. Lift blacks slightly scaling with phosphor setting
                    color += 0.05 * u_phosphor; 

                    // 2. Add subtle background noise (phosphor grain) - CHAOTIC STATIC
                    // Use u_time to randomize the seed vector every frame
                    float noise = fract(sin(dot(curvedUV, vec2(12.9898, 78.233) + u_time)) * 43758.5453);
                    color += noise * 0.05 * u_phosphor;
                }

                // Scanlines (Analytic Sinc-Integrated Fourier Beam with Timothy Lottes Phase Jitter)
                if (u_scanlineCount > 0.0 && u_scanlineIntensity > 0.0) {
                    float pos = rasterUV.y * u_scanlineCount;

                    // 1. Screen-space pixel footprint in scanline units
                    #ifdef GL_OES_standard_derivatives
                    float w = max(length(vec2(dFdx(pos), dFdy(pos))), 0.0001);
                    #else
                    float w = max(u_scanlineCount / u_resolution.y, 0.0001);
                    #endif

                    // 2. Timothy Lottes Phase Jitter: decorrelates discrete phase beats
                    vec3 magic = vec3(0.06711056, 0.00583715, 52.9829189);
                    float dither = fract(magic.z * fract(dot(v_texCoord * u_resolution, magic.xy))) - 0.5;
                    float jPos = pos + dither * min(w * 0.4, 0.15);

                    // 3. Analytic Area Integration (Sinc-filtered harmonics over the pixel interval):
                    // Eliminates non-integer scaling stepping (3-4-3-4 px alternating thickness)
                    float angle = 6.28318530718 * jPos;
                    float piW = 3.14159265359 * w;
                    float sinc1 = sin(piW) / piW;
                    float sinc2 = sin(2.0 * piW) / (2.0 * piW);

                    // 1st harmonic shapes the fundamental valley, 2nd harmonic sharpens the electron beam peak
                    float harmonics = 0.75 * sinc1 * cos(angle) + 0.25 * sinc2 * cos(2.0 * angle);

                    // Map harmonics [-0.5, 1.0] to normalized beam intensity [0.0, 1.0]
                    float beam = clamp(0.6666667 * harmonics + 0.3333333, 0.0, 1.0);

                    // 4. Beam Spot Modulation (Dynamic electron beam widening on bright pixels)
                    float luma = dot(color, vec3(0.2126, 0.7152, 0.0722));
                    float effectiveIntensity = u_scanlineIntensity * mix(1.0, max(0.1, 1.0 - luma * 0.9), u_beamModulation);

                    // 5. Intensity Modulation: perfectly uniform across all lines and resolutions
                    float scanline = mix(1.0 - (effectiveIntensity * 0.6), 1.0, beam);
                    color *= scanline;
                }

                // CRT Ambient Screen Glow (Wide diffuse glass light scatter applied OVER the scanline raster)
                if (u_glow > 0.0) {
                     float glowRadius = 0.18;
                     vec3 glowSum = vec3(0.0);
                     float totalGlowWeight = 0.0;
                     
                     // Dither pattern to ensure smooth blur without concentric banding
                     vec3 magic = vec3(0.06711056, 0.00583715, 52.9829189);
                     float dither = fract(magic.z * fract(dot(v_texCoord * u_resolution, magic.xy)));
                     float startAngle = dither * 6.28318530718;

                     for (int i = 0; i < 16; i++) {
                          float fi = float(i) + dither;
                          float normDist = sqrt(fi / 16.0);
                          float r = normDist * glowRadius;
                          float theta = startAngle + float(i) * 2.39996323;

                          vec2 g_offset = vec2(cos(theta), sin(theta)) * r;
                          g_offset.y *= 0.75; // aspect ratio correction

                          float weight = exp(-normDist * normDist * 2.2);
                          glowSum += sampleScreen(rasterUV + g_offset) * weight;
                          totalGlowWeight += weight;
                     }
                     glowSum /= max(totalGlowWeight, 0.001);

                     // Slight desaturation: diffuse light scattered inside thick CRT faceplate glass is less chromatic
                     float glowLuma = dot(glowSum, vec3(0.2126, 0.7152, 0.0722));
                     glowSum = mix(glowSum, vec3(glowLuma), 0.35);

                     // Screen blend mode: illuminates both phosphors and scanline gaps
                     vec3 diffuseGlow = glowSum * u_glow * 0.5;
                     color = 1.0 - (1.0 - color) * (1.0 - diffuseGlow);
                }

                // Vignette (Physical curved faceplate glass property)
                float vignette = curvedUV.x * curvedUV.y * (1.0 - curvedUV.x) * (1.0 - curvedUV.y);
                float vig = pow(vignette * (15.0), 0.25);
                color *= mix(1.0, vig, u_vignette);

                // Brightness boost (static for now)
                color *= 1.1;

                // Monochrome phosphor presets. Color mode leaves the source RGB untouched;
                // monochrome modes preserve luminance and tint it like a real phosphor.
                if (u_colorMode > 0.5) {
                    float luma = dot(color, vec3(0.2126, 0.7152, 0.0722));
                    vec3 phosphorTint = vec3(1.0);
                    if (u_colorMode < 1.5) phosphorTint = vec3(1.0); // B&W, D65 white point (~6500K)
                    else if (u_colorMode < 2.5) phosphorTint = vec3(0.45, 1.0, 0.62); // Green
                    else if (u_colorMode < 3.5) phosphorTint = vec3(1.0, 0.58, 0.2); // Amber
                    else phosphorTint = vec3(0.42, 0.72, 1.0); // Phosphor Blue
                    color = luma * phosphorTint;
                }

                gl_FragColor = vec4(color, 1.0);
            }
        `;

    this.program = this.createProgram(gl, vsSource, fsSource);
    if (!this.program) return;

    // Look up locations
    this.positionLocation = gl.getAttribLocation(this.program, 'a_position');
    this.texCoordLocation = gl.getAttribLocation(this.program, 'a_texCoord');
    this.resolutionLocation = gl.getUniformLocation(this.program, 'u_resolution');
    this.timeLocation = gl.getUniformLocation(this.program, 'u_time');
    this.scanlineCountLocation = gl.getUniformLocation(this.program, 'u_scanlineCount');
    this.curvatureLocation = gl.getUniformLocation(this.program, 'u_curvature');
    this.aberrationLocation = gl.getUniformLocation(this.program, 'u_aberration');
    this.vignetteLocation = gl.getUniformLocation(this.program, 'u_vignette');
    this.scanlineIntensityLocation = gl.getUniformLocation(this.program, 'u_scanlineIntensity');
    this.phosphorLocation = gl.getUniformLocation(this.program, 'u_phosphor');
    this.bezelGlowLocation = gl.getUniformLocation(this.program, 'u_bezelGlow');
    this.bloomLocation = gl.getUniformLocation(this.program, 'u_bloom');
    this.glowLocation = gl.getUniformLocation(this.program, 'u_glow');
    this.trailLocation = gl.getUniformLocation(this.program, 'u_trail');
    this.persistenceLocation = gl.getUniformLocation(this.program, 'u_persistence');
    this.persistenceIntensityLocation = gl.getUniformLocation(this.program, 'u_persistenceIntensity');
    this.beamModulationLocation = gl.getUniformLocation(this.program, 'u_beamModulation');
    this.breathingScaleLocation = gl.getUniformLocation(this.program, 'u_breathingScale');
    this.sourceResolutionLocation = gl.getUniformLocation(this.program, 'u_sourceResolution');
    this.antiAliasedPixelsLocation = gl.getUniformLocation(this.program, 'u_antiAliasedPixels');
    this.colorModeLocation = gl.getUniformLocation(this.program, 'u_colorMode');
    this.imageLocation = gl.getUniformLocation(this.program, 'u_image');

    // Create buffer for a quad (2 triangles)
    this.buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([
        -1.0, -1.0, 0.0, 1.0, 1.0, -1.0, 1.0, 1.0, -1.0, 1.0, 0.0, 0.0, -1.0, 1.0, 0.0, 0.0, 1.0,
        -1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 0.0,
      ]),
      gl.STATIC_DRAW
    );

    // Create texture with LINEAR filtering for subpixel anti-aliased interpolation
    this.texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

    // Accumulation / Persistence Shader Pass
    const accumVsSource = `
      attribute vec2 a_position;
      attribute vec2 a_texCoord;
      varying vec2 v_texCoord;
      void main() {
          gl_Position = vec4(a_position.x, -a_position.y, 0.0, 1.0);
          v_texCoord = a_texCoord;
      }
    `;

    const accumFsSource = `
      precision mediump float;
      uniform sampler2D u_current;
      uniform sampler2D u_history;
      uniform float u_persistence;
      varying vec2 v_texCoord;

      void main() {
          vec3 current = texture2D(u_current, v_texCoord).rgb;
          vec3 history = texture2D(u_history, v_texCoord).rgb;
          
          // Maximum duration is approximately doubled; time-based decay remains backlog work.
          float decay = mix(0.20, 0.9915, clamp(u_persistence, 0.0, 1.0));
          
          // Quantization cutoff: subtracting 0.5/255 guarantees 8-bit framebuffers decay to absolute 0
          // without getting stuck at a 1/255 truncation floor ("phosphor burn-in")
          vec3 decayedHistory = max(vec3(0.0), history * decay - vec3(0.5 / 255.0));

          // Soft translucent trail: enters at 9% of active source brightness for an ultra-delicate afterglow
          vec3 trail = max(current * 0.09, decayedHistory);

          // Slight desaturation: phosphor afterglow naturally loses saturation as it decays
          float luma = dot(trail, vec3(0.2126, 0.7152, 0.0722));
          trail = mix(trail, vec3(luma), 0.35);

          gl_FragColor = vec4(trail, 1.0);
      }
    `;

    this.accumProgram = this.createProgram(gl, accumVsSource, accumFsSource);
    if (this.accumProgram) {
      this.accumPosLocation = gl.getAttribLocation(this.accumProgram, 'a_position');
      this.accumTexCoordLocation = gl.getAttribLocation(this.accumProgram, 'a_texCoord');
      this.accumCurrentTexLocation = gl.getUniformLocation(this.accumProgram, 'u_current');
      this.accumHistoryTexLocation = gl.getUniformLocation(this.accumProgram, 'u_history');
      this.accumPersistenceLocation = gl.getUniformLocation(this.accumProgram, 'u_persistence');
    }
  }

  ensureFBO(width: number, height: number): boolean {
    if (!this.gl) return false;
    const gl = this.gl;
    if (this.fboA && this.fboWidth === width && this.fboHeight === height) return true;

    if (this.fboA) gl.deleteFramebuffer(this.fboA);
    if (this.fboB) gl.deleteFramebuffer(this.fboB);
    if (this.fboTexA) gl.deleteTexture(this.fboTexA);
    if (this.fboTexB) gl.deleteTexture(this.fboTexB);

    this.fboWidth = width;
    this.fboHeight = height;

    const createFBOWithTex = () => {
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

      const fbo = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      return { fbo, tex };
    };

    const a = createFBOWithTex();
    const b = createFBOWithTex();
    this.fboA = a.fbo;
    this.fboTexA = a.tex;
    this.fboB = b.fbo;
    this.fboTexB = b.tex;
    this.fboCurrent = 0;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return true;
  }

  clearPersistence(): void {
    if (!this.gl || !this.fboA || !this.fboB) return;
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fboA);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fboB);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  isValid(): boolean {
    return !!(this.gl && this.program && this.buffer && this.texture);
  }

  dispose(): void {
    if (!this.gl) return;
    const gl = this.gl;
    if (this.fboA) gl.deleteFramebuffer(this.fboA);
    if (this.fboB) gl.deleteFramebuffer(this.fboB);
    if (this.fboTexA) gl.deleteTexture(this.fboTexA);
    if (this.fboTexB) gl.deleteTexture(this.fboTexB);
    if (this.texture) gl.deleteTexture(this.texture);
    if (this.buffer) gl.deleteBuffer(this.buffer);
    if (this.program) gl.deleteProgram(this.program);
    if (this.accumProgram) gl.deleteProgram(this.accumProgram);
    this.fboA = null;
    this.fboB = null;
    this.fboTexA = null;
    this.fboTexB = null;
    this.texture = null;
    this.buffer = null;
    this.program = null;
    this.accumProgram = null;
  }

  render(sourceCanvas: HTMLCanvasElement, settings: CRTSettings): void {
    if (!this.gl || !this.program || !this.buffer || !this.texture) return;
    const gl = this.gl;

    // 1. Upload source canvas to texture
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, sourceCanvas);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

    let activeInputTexture = this.texture;

    // 2. Accumulation Pass for Phosphor Persistence (if enabled)
    const persistence = settings.persistence || 0.0;
    if (persistence > 0.0 && this.accumProgram) {
      this.ensureFBO(sourceCanvas.width, sourceCanvas.height);
      const targetFBO = this.fboCurrent === 0 ? this.fboA : this.fboB;
      const targetTex = this.fboCurrent === 0 ? this.fboTexA : this.fboTexB;
      const historyTex = this.fboCurrent === 0 ? this.fboTexB : this.fboTexA;

      gl.bindFramebuffer(gl.FRAMEBUFFER, targetFBO);
      gl.viewport(0, 0, this.fboWidth, this.fboHeight);

      gl.useProgram(this.accumProgram);

      gl.enableVertexAttribArray(this.accumPosLocation);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
      gl.vertexAttribPointer(this.accumPosLocation, 2, gl.FLOAT, false, 16, 0);

      gl.enableVertexAttribArray(this.accumTexCoordLocation);
      gl.vertexAttribPointer(this.accumTexCoordLocation, 2, gl.FLOAT, false, 16, 8);

      // Texture Unit 0: Current frame
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.texture);
      if (this.accumCurrentTexLocation) gl.uniform1i(this.accumCurrentTexLocation, 0);

      // Texture Unit 1: History frame
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, historyTex);
      if (this.accumHistoryTexLocation) gl.uniform1i(this.accumHistoryTexLocation, 1);

      if (this.accumPersistenceLocation) gl.uniform1f(this.accumPersistenceLocation, persistence);

      gl.drawArrays(gl.TRIANGLES, 0, 6);

      // Swap ping-pong
      this.fboCurrent = 1 - this.fboCurrent;
      if (targetTex) activeInputTexture = targetTex;
    } else {
      // If persistence was disabled, clear history FBOs to prevent stale trails from lingering
      if (this.fboA && this.fboB) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.fboA);
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.fboB);
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      }
    }

    // 3. Final CRT Pass (Render to Screen)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);

    gl.useProgram(this.program);

    // Bind attributes
    gl.enableVertexAttribArray(this.positionLocation);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    gl.vertexAttribPointer(this.positionLocation, 2, gl.FLOAT, false, 16, 0);

    gl.enableVertexAttribArray(this.texCoordLocation);
    gl.vertexAttribPointer(this.texCoordLocation, 2, gl.FLOAT, false, 16, 8);

    // Uniforms
    if (this.resolutionLocation)
      gl.uniform2f(this.resolutionLocation, this.canvas.width, this.canvas.height);
    if (this.timeLocation) gl.uniform1f(this.timeLocation, performance.now() / 1000);

    if (this.scanlineCountLocation)
      gl.uniform1f(this.scanlineCountLocation, settings.scanlineCount);
    if (this.curvatureLocation) gl.uniform1f(this.curvatureLocation, settings.curvature);
    if (this.scanlineIntensityLocation)
      gl.uniform1f(this.scanlineIntensityLocation, settings.scanlineIntensity);
    if (this.aberrationLocation) gl.uniform1f(this.aberrationLocation, settings.aberration);
    if (this.vignetteLocation) gl.uniform1f(this.vignetteLocation, settings.vignette);
    if (this.phosphorLocation) gl.uniform1f(this.phosphorLocation, settings.phosphor || 0.0);
    if (this.bezelGlowLocation)
      gl.uniform1f(this.bezelGlowLocation, settings.bezelGlow ? 1.0 : 0.0);
    if (this.bloomLocation) gl.uniform1f(this.bloomLocation, settings.bloom || 0.0);
    if (this.glowLocation) gl.uniform1f(this.glowLocation, settings.glow || 0.0);
    if (this.beamModulationLocation)
      gl.uniform1f(this.beamModulationLocation, settings.beamModulation ?? 0.0);
    if (this.sourceResolutionLocation)
      gl.uniform2f(this.sourceResolutionLocation, sourceCanvas.width, sourceCanvas.height);
    if (this.antiAliasedPixelsLocation)
      gl.uniform1f(this.antiAliasedPixelsLocation, settings.antiAliasedPixels !== false ? 1.0 : 0.0);
    if (this.colorModeLocation) {
      const colorMode = { color: 0, bw: 1, green: 2, amber: 3, blue: 4 }[settings.colorMode] ?? 0;
      gl.uniform1f(this.colorModeLocation, colorMode);
    }

    // High-Voltage Anode Breathing (Raster Bloom expansion on bright scenes)
    let breathingScale = 0.0;
    const breathingSetting = settings.breathing || 0.0;
    if (breathingSetting > 0.0) {
      const now = performance.now();
      const dt =
        this.lastBreathingTime > 0
          ? Math.min(0.1, (now - this.lastBreathingTime) / 1000)
          : 0.016;
      this.lastBreathingTime = now;

      let avgLuma = 0.12;
      const ctx = sourceCanvas.getContext('2d');
      if (ctx) {
        try {
          const w = sourceCanvas.width;
          const h = sourceCanvas.height;
          const imgData = ctx.getImageData(0, 0, w, h);
          const data = imgData.data;
          let sum = 0;
          const sampleStep = Math.max(1, Math.floor(data.length / (4 * 64))); // 64 grid samples across buffer
          let sampleCount = 0;
          for (let i = 0; i < data.length; i += sampleStep * 4) {
            sum +=
              (data[i] * 0.2126 + data[i + 1] * 0.7152 + data[i + 2] * 0.0722) / 255;
            sampleCount++;
          }
          if (sampleCount > 0) avgLuma = sum / sampleCount;
        } catch {
          // Some canvas implementations do not allow pixel reads.
        }
      }

      // Expansion ranges from resting narrow border (avgLuma=0) to slight overscan under the bezel (avgLuma=1)
      const targetExpansion = (0.004 + avgLuma * 0.038) * breathingSetting;
      this.smoothedExpansion +=
        (targetExpansion - this.smoothedExpansion) * (1.0 - Math.exp(-dt * 12.0));
      breathingScale = this.smoothedExpansion;
    } else {
      this.smoothedExpansion = 0.0;
      this.lastBreathingTime = 0;
    }
    if (this.breathingScaleLocation) gl.uniform1f(this.breathingScaleLocation, breathingScale);

    // Texture Unit 0: Main Image (Sharp active frame)
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    if (this.imageLocation) gl.uniform1i(this.imageLocation, 0);

    // Texture Unit 1: Phosphor Trail (if persistence enabled)
    if (persistence > 0.0) {
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, activeInputTexture);
      if (this.trailLocation) gl.uniform1i(this.trailLocation, 1);
      if (this.persistenceLocation) gl.uniform1f(this.persistenceLocation, persistence);
      if (this.persistenceIntensityLocation) {
        gl.uniform1f(this.persistenceIntensityLocation, settings.persistenceIntensity);
      }
    } else {
      if (this.persistenceLocation) gl.uniform1f(this.persistenceLocation, 0.0);
      if (this.persistenceIntensityLocation) gl.uniform1f(this.persistenceIntensityLocation, 0.0);
    }

    // Draw Main
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }
}
