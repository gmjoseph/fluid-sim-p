const DEBUG = false;

class Shader {
    constructor(gl, vertCode, fragCode) {
        this.program = null;
        this.setupShader(gl, vertCode, fragCode);
    }

    setupShader(gl, vertCode, fragCode) {
        const log = (shader) => {
            const compiled = gl.getShaderParameter(shader, gl.COMPILE_STATUS);
            if (!compiled) {
                console.log('Shader compiled failed: ' + compiled);
            
                const compilationLog = gl.getShaderInfoLog(shader);
                console.log('Shader compiler log: ' + compilationLog);
            }
        };

        const vertShader = gl.createShader(gl.VERTEX_SHADER);
        gl.shaderSource(vertShader, vertCode);
        gl.compileShader(vertShader);
        log(vertShader);
        
    
        const fragShader = gl.createShader(gl.FRAGMENT_SHADER);
        gl.shaderSource(fragShader, fragCode); 
        gl.compileShader(fragShader);
        log(fragShader);
        
        const shaderProgram = gl.createProgram();
        gl.attachShader(shaderProgram, vertShader);
        gl.attachShader(shaderProgram, fragShader);
        gl.linkProgram(shaderProgram);

        this.program = shaderProgram
    }

    cacheUniformLocations(gl, uniformNames) {
        uniformNames.forEach(name => {
            const key = `${name}Location`;
            this[key] = gl.getUniformLocation(this.program, name);
        });
    }

    cacheAttributeLocations(gl, attributeNames) {
        attributeNames.forEach(name => {
            const key = `${name}Location`;
            const location = gl.getAttribLocation(this.program, name);
            this[key] = location;
        });
    }

    debugAttributes(gl) {
        const { program } = this;
        const numAttribs = gl.getProgramParameter(program, gl.ACTIVE_ATTRIBUTES);
            for (let i = 0; i < numAttribs; ++i) {
            const info = gl.getActiveAttrib(program, i);
            console.log('name:', info.name, 'type:', info.type, 'size:', info.size);
        }
    }
}

class Quad {
    constructor(gl) {
        this.vao = null;
        this.positions = {
            data: null,
            buffer: null,
        };
        this.indices = {
            data: null,
            buffer: null,
        };

        this.setupBuffers(gl);
    }

    createBuffer(gl, type, data) {
        const bufferType = gl[type];
        const buffer = gl.createBuffer();
        gl.bindBuffer(bufferType, buffer);
        gl.bufferData(bufferType, data, gl.STATIC_DRAW);
        return buffer;
    }

    setupBuffers(gl) {
        // All the vertexAttribArray things associate with this. We can then swap between them
        // to render to the object, or to render to screen.
        this.vao = gl.createVertexArray();
        gl.bindVertexArray(this.vao);

        this.positions.data = new Float32Array([
            // top left
            -1, 1,
            // top right
            1, 1,
            // bottom left
            -1, -1,
            // bottom right
            1, -1,
        ]);
        // this.indices.data = new Uint8Array([0, 1, 2, 2, 1, 3]);
        this.indices.data = new Uint8Array([2, 1, 0, 3, 1, 2]);

        this.positions.buffer = this.createBuffer(gl, 'ARRAY_BUFFER', this.positions.data);
        this.indices.buffer = this.createBuffer(gl, 'ELEMENT_ARRAY_BUFFER', this.indices.data);

        // Positions
        gl.bindBuffer(gl.ARRAY_BUFFER, this.positions.buffer);
        // It's always at layout(location = 0) (see the shaders below), so no
        // need to query it and reuse it.
        gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 8, 0);
        gl.enableVertexAttribArray(0);
        gl.bindBuffer(gl.ARRAY_BUFFER, null);
        gl.bindVertexArray(null);
    }

    draw(gl) {
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.bindVertexArray(this.vao);
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indices.buffer);
        gl.drawElements(gl.TRIANGLES, this.indices.data.length, gl.UNSIGNED_BYTE, 0);
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, null);
        gl.bindVertexArray(null);
    }
}

const VERTEX = `#version 300 es
    precision highp float;
    layout(location = 0) in vec2 a_position;

    void main(void) {
        gl_Position = vec4(a_position, 0., 1.);
    }
`;

class GL {
    constructor(size, mode) {
        const canvas = document.getElementById('canvas');
        canvas.width = size;
        canvas.height = size;
        this.size = size;
        this.mode = mode;

        const gl = canvas.getContext('webgl2', {
            alpha: true,
            antialias: true,
            depth: false,
            premultipliedAlpha: false,
        });
        this.gl = gl;
        const ext = gl.getExtension("EXT_color_buffer_float");
        if (!ext) {
            throw new Error("EXT_color_buffer_float needed, sorry, can't render to floating point textures");
        }

        this.shaders = {
            // fan density + velocity
            addFanDensity: null,
            addFanVelocity: null,
            // mouse density + velocity
            addMouseDensity: null,
            addMouseVelocity: null,
            // solvers
            solveLinear: null,
            advect: null,
            divergence: null,
            velocity: null,
            setBoundary: null,
            // final render
            render: null,
        };

        this.setupAddFanDensityForces();
        this.setupAddMouseDensityForces();
        this.setupSolveLinear();
        this.setupAdvect();
        this.setupDivergence();
        this.setupVelocity();
        this.setupSetBoundary();
        this.setupFade();
        this.setupRender();

        this.textures = {
            // velocity textures
            // todo
            // combine u and v (x and y components of velocity) into one uv.
            u0: null,
            u0Next: null,
            u: null,
            uNext: null,
            v0: null,
            v0Next: null,
            v: null,
            vNext: null,
            // density textures
            x0: null,
            x0Next: null,
            x: null,
            xNext: null,
        };

        this.setupTextures();

        this.fb = null;
        this.createFramebuffer();

        gl.clearColor(1.0, 0.0, 0.0, 1.0);
        gl.viewport(0, 0, size, size);

        this.quad = new Quad(gl);
    }

    setupAddFanDensityForces() {
        const { gl } = this;
        {
            const fragment = `#version 300 es
            precision highp float;
            uniform sampler2D u_x;
            uniform float u_source_density;

            out vec4 colour;

            void main(void) {
                ivec2 p = ivec2(gl_FragCoord.xy);
                ivec2 size = textureSize(u_x, 0);
                float x = texelFetch(u_x, p, 0).r;
                colour.r = x;

                if (p.x == 1) {
                    float strength = 1. - abs((float(p.y) / float(size.y)) * 2. - 1.);
                    colour.r = x + u_source_density * strength * 10.;
                }
            }
            `;

            this.shaders.addFanDensity = new Shader(gl, VERTEX, fragment);
            this.shaders.addFanDensity.cacheUniformLocations(gl, [
                'u_x',
                'u_source_density',
            ]);
        }
        {
            const fragment = `#version 300 es
            precision highp float;
            uniform sampler2D u_u;

            out vec4 colour;

            void main(void) {
                ivec2 p = ivec2(gl_FragCoord.xy);
                ivec2 size = textureSize(u_u, 0);
                float u = texelFetch(u_u, p, 0).r;
                colour.r = u;

                if (p.x == 1) {
                    float strength = 1. - abs((float(p.y) / float(size.y)) * 2. - 1.);
                    colour.r = u + strength * 5.;
                }
            }
            `;

            this.shaders.addFanVelocity = new Shader(gl, VERTEX, fragment);
            this.shaders.addFanVelocity.cacheUniformLocations(gl, [
                'u_x',
            ]);
        }
    }

    setupAddMouseDensityForces() {
        const { gl } = this;
        {
            const fragment = `#version 300 es
            precision highp float;
            uniform sampler2D u_x;
            uniform float u_source_density;
            uniform ivec2 u_target;

            out vec4 colour;

            void main(void) {
                ivec2 p = ivec2(gl_FragCoord.xy);
                float x = texelFetch(u_x, p, 0).r;
                colour.r = x;

                if (p.x == u_target.x && p.y == u_target.y) {
                    colour.r = x + u_source_density;
                }
                if (p.x - 1 == u_target.x && p.y == u_target.y) {
                    colour.r = x + u_source_density;
                }
                if (p.x + 1 == u_target.x && p.y == u_target.y) {
                    colour.r = x + u_source_density;
                }
                if (p.x == u_target.x && p.y - 1 == u_target.y) {
                    colour.r = x + u_source_density;
                }
                if (p.x == u_target.x && p.y + 1 == u_target.y) {
                    colour.r = x + u_source_density;
                }
            }
            `;

            this.shaders.addMouseDensity = new Shader(gl, VERTEX, fragment);
            this.shaders.addMouseDensity.cacheUniformLocations(gl, [
                'u_x',
                'u_source_density',
                'u_target',
            ]);
        }
        {
            const fragment = `#version 300 es
            precision highp float;
            uniform sampler2D u_uv;
            uniform ivec2 u_target;
            uniform float u_velocity;

            out vec4 colour;

            void main(void) {
                ivec2 p = ivec2(gl_FragCoord.xy);
                float uv = texelFetch(u_uv, p, 0).r;
                colour.r = uv;

                if (p.x == u_target.x && p.y == u_target.y) {
                    colour.r = uv + u_velocity * (2. / (abs(u_velocity) + 1.)) * 15.;
                }
            }
            `;

            this.shaders.addMouseVelocity = new Shader(gl, VERTEX, fragment);
            this.shaders.addMouseVelocity.cacheUniformLocations(gl, [
                'u_uv',
                'u_target',
                'u_velocity',
            ]);
        }
    }

    setupSolveLinear() {
        const { gl } = this;

        const fragment = `#version 300 es
        precision highp float;
        uniform sampler2D u_x;
        uniform sampler2D u_x0;
        uniform float u_a;
        uniform float u_c;

        out vec4 colour;

        void main(void) {
            ivec2 p = ivec2(gl_FragCoord.xy);
            float l = texelFetch(u_x, p - ivec2(1, 0), 0).r;
            float r = texelFetch(u_x, p + ivec2(1, 0), 0).r;
            float t = texelFetch(u_x, p - ivec2(0, 1), 0).r;
            float b = texelFetch(u_x, p + ivec2(0, 1), 0).r;
            float x0 = texelFetch(u_x0, p, 0).r;
            colour.r = (u_a / u_c) * (x0 + l + r + t + b);
            // }
            // debug
            // colour.r = texelFetch(u_x0, p, 0).r;
        }
        `;

        this.shaders.solveLinear = new Shader(gl, VERTEX, fragment);
        this.shaders.solveLinear.cacheUniformLocations(gl, [
            'u_x',
            'u_x0',
            'u_a',
            'u_c',
        ]);
    }

    setupAdvect() {
        const { gl } = this;

        const fragment = `#version 300 es
        precision highp float;
        uniform sampler2D u_source;
        uniform sampler2D u_u;
        uniform sampler2D u_v;
        uniform float u_dt0;

        out vec4 colour;

        void main(void) {
            ivec2 p = ivec2(gl_FragCoord.xy);
            ivec2 size = textureSize(u_source, 0);
            // size without the boundary.
            size -= ivec2(2);

            // TODO
            // lots of room to improve this with vectorization / matrices.
            float x = float(p.x) - u_dt0 * texelFetch(u_u, p, 0).r;
            x = clamp(x, 0.5, float(size.x));

            float y = float(p.y) - u_dt0 * texelFetch(u_v, p, 0).r;
            y = clamp(y, 0.5, float(size.y));

            int i0 = int(x);
            int i1 = i0 + 1;

            int j0 = int(y);
            int j1 = j0 + 1;

            float s1 = x - float(i0);
            float s0 = 1. - s1;

            float t1 = y - float(j0);
            float t0 = 1. - t1;

            float a = texelFetch(u_source, ivec2(i0, j0), 0).r;
            float b = texelFetch(u_source, ivec2(i0, j1), 0).r;
            float c = texelFetch(u_source, ivec2(i1, j0), 0).r;
            float d = texelFetch(u_source, ivec2(i1, j1), 0).r;

            // this looks like a matrix
            colour.r = s0 * (t0 * a + t1 * b) + s1 * (t0 * c + t1 * d);
        }
        `;

        this.shaders.advect = new Shader(gl, VERTEX, fragment);
        this.shaders.advect.cacheUniformLocations(gl, [
            'u_source',
            'u_u',
            'u_v',
            'u_dt0',
        ]);
    }

    setupDivergence() {
        const { gl } = this;

        const fragment = `#version 300 es
        precision highp float;
        uniform sampler2D u_u;
        uniform sampler2D u_v;
        uniform float u_h;

        out vec4 colour;

        void main(void) {
            ivec2 p = ivec2(gl_FragCoord.xy);
            float l = texelFetch(u_u, p - ivec2(1, 0), 0).r;
            float r = texelFetch(u_u, p + ivec2(1, 0), 0).r;
            float t = texelFetch(u_v, p - ivec2(0, 1), 0).r;
            float b = texelFetch(u_v, p + ivec2(0, 1), 0).r;
            colour.r = -0.5 * u_h * (r - l + b - t);
        }
        `;

        this.shaders.divergence = new Shader(gl, VERTEX, fragment);
        this.shaders.divergence.cacheUniformLocations(gl, [
            'u_u',
            'u_v',
            'u_h',
        ]);
    }

    setupVelocity() {
        const { gl } = this;

        const fragment = `#version 300 es
        precision highp float;
        uniform sampler2D u_uv;
        uniform sampler2D u_p;
        uniform float u_h;
        uniform int u_direction;

        out vec4 colour;

        void main(void) {
            ivec2 p = ivec2(gl_FragCoord.xy);
            float uv = texelFetch(u_uv, p, 0).r;
            float l = texelFetch(u_p, p - ivec2(1, 0), 0).r;
            float r = texelFetch(u_p, p + ivec2(1, 0), 0).r;
            float t = texelFetch(u_p, p - ivec2(0, 1), 0).r;
            float b = texelFetch(u_p, p + ivec2(0, 1), 0).r;

            // todo
            // when we combine uv into an actual thing with x and y and not
            // just a per-direction ur and v map, then this can be removed and
            // done in one go.
            if (u_direction == 0) {
                // left-right
                colour.r = uv - 0.5 * (r - l) * 1. / u_h;
            } else {
                // up-down
                colour.r = uv -0.5 * (b - t) * 1. / u_h;
            }
        }
        `;

        this.shaders.velocity = new Shader(gl, VERTEX, fragment);
        this.shaders.velocity.cacheUniformLocations(gl, [
            'u_uv',
            'u_p',
            'u_h',
            'u_direction',
        ]);
    }

    setupSetBoundary() {
        const { gl } = this;

        const fragment = `#version 300 es
        precision highp float;
        uniform sampler2D u_x;
        uniform int u_b;

        out vec4 colour;

        float get(int x, int y) {
            return texelFetch(u_x, ivec2(x, y), 0).r;
        }

        void main(void) {
            ivec2 p = ivec2(gl_FragCoord.xy);
            ivec2 size = textureSize(u_x, 0);
            size -= ivec2(2);

            colour.r = get(p.x, p.y);

            if (p.x == 0 && p.y >= 1) {
                float mult = u_b == 1 ? -1. : 1.;
                colour.r = mult * get(1, p.y);
            }
            if (p.x == size.x + 1 && p.y >= 1) {
                float mult = u_b == 1 ? -1. : 1.;
                colour.r = mult * get(size.x, p.y);
            }
            if (p.x >= 1 && p.y == 0) {
                float mult = u_b == 2 ? -1. : 1.;
                colour.r = mult * get(p.x, 1);
            }
            if (p.x >= 1 && p.y == size.y + 1) {
                float mult = u_b == 2 ? -1. : 1.;
                colour.r = mult * get(p.x, size.y);
            }

            // corner overrides
            if (p.x == 0 && p.y == 0) {
                colour.r = 0.5 * (get(1, 0) + get(0, 1));
            }
            if (p.x == 0 && p.y == size.y + 1) {
                colour.r = 0.5 * (get(1, size.y + 1) + get(0, size.y));
            }
            if (p.x == size.x + 1 && p.y == 0) {
                colour.r = 0.5 * (get(size.x, 0) + get(size.x + 1, 1));
            }
            if (p.x == size.x + 1 && p.y == size.y + 1) {
                colour.r = 0.5 * (get(size.x, size.y + 1) + get(size.x + 1, size.y));
            }
            
            // // Add a circular boundary in the middle
            // // This will cause the fluid to flow around this like a dead zone.
            // vec2 centre = vec2(size) * 0.5;
            // vec2 fp = vec2(p);
            // float radius = centre.x * 0.25;

            // if (distance(centre, fp) < radius) {
            //     colour.r = -1. * get(p.x, p.y);
            // }
        }
        `;

        this.shaders.setBoundary = new Shader(gl, VERTEX, fragment);
        this.shaders.setBoundary.cacheUniformLocations(gl, [
            'u_x',
            'u_b',
        ]);
    }

    setupFade() {
        const { gl } = this;
        const fragment = `#version 300 es
        precision highp float;
        uniform sampler2D u_x;
        uniform float u_density_decay;

        out vec4 colour;

        void main(void) {
            ivec2 p = ivec2(gl_FragCoord.xy);
            float x = texelFetch(u_x, p, 0).r;
            x -= u_density_decay;
            x = clamp(x, 0., 255.);
            colour.r = x;
        }
        `;

        this.shaders.fade = new Shader(gl, VERTEX, fragment);
        this.shaders.fade.cacheUniformLocations(gl, [
            'u_x',
            'u_density_decay',
        ]);
    }

    setupRender() {
        const { gl } = this;
        const fragment = `#version 300 es
        precision highp float;
        uniform sampler2D u_x;

        out vec4 colour;

        vec4 mouse_colour(void) {
            ivec2 p = ivec2(gl_FragCoord.xy);
            ivec2 size = textureSize(u_x, 0);

            float density = texelFetch(u_x, p, 0).r;
            float d = float(int(density * 255.));
            float div = 1./255.;

            vec4 c;
            c.r = mod(density + 50., 255.) * div;
            c.g = 200. * div;
            c.b = d * div;
            c.a = d * div;
            return c;
        }

        vec4 fan_colour_green_white(void) {
            // p coordinates are integer indices into the texture form [0, size]
            // on both axes.
            ivec2 p = ivec2(gl_FragCoord.xy);
            ivec2 size = textureSize(u_x, 0);

            vec4 c;

            int density = int(texelFetch(u_x, p, 0).r);
            // gives us a [0, 255] value.
            float div = 1./255.;
            float n_density = float(density) * div;

            c.r = float(density) * div;
            c.g = 1.;
            c.b = n_density;
            c.a = n_density;
            // return vec4(float(p.x) / float(size.x), float(p.y) / float(size.y), 0, 1.0);
            return c;
        }

        vec4 fan_colour_pink_blue(void) {
            ivec2 p = ivec2(gl_FragCoord.xy);
            ivec2 size = textureSize(u_x, 0);

            float density = texelFetch(u_x, p, 0).r;
            float d = float(int(density * 255.));
            float div = 1./255.;

            vec4 c;
            c.r = mod(density + 254., 255.) * div;
            c.g = 1. * div;
            c.b = d * div;
            c.a = d * div;  
            return c;
        }

        vec4 fan_colour_neon_blue(void) {
            ivec2 p = ivec2(gl_FragCoord.xy);
            ivec2 size = textureSize(u_x, 0);

            float density = texelFetch(u_x, p, 0).r;
            float d = float(int(density * 255.));
            float div = 1./255.;

            vec4 c;
            c.r = 1. * div;
            c.g = mod(density + 254., 255.) * div;
            c.b = d * div;
            c.a = d * div;
            return c;
        }

        void main(void) {
            ivec2 p = ivec2(gl_FragCoord.xy);
            ivec2 size = textureSize(u_x, 0);
            
            // TODO
            // always use mouse_colour til i can figure out the random black
            // pixels in fan_colour? 1 = mouse, 3 = mouseauto
            colour = ${this.mode === 1 || this.mode === 3? 'mouse_colour()' : 'fan_colour_green_white()'};
            // colour = mouse_colour();

            // float density = texelFetch(u_x, p, 0).r
            // colour = vec4(density);
            if (p.x < 2 || p.y < 2 || p.x >= size.x - 2 || p.y > size.y - 2) {
                colour = vec4(1.);
            }
        }
        `;

        this.shaders.render = new Shader(gl, VERTEX, fragment);
        this.shaders.render.cacheUniformLocations(gl, [
            'u_x',
        ]);
    }

    setupTextures() {
        const { size } = this;
        Object.keys(this.textures).forEach(k => {
            // Seeded data values
            // if (k === 'x' || k === 'x0') {
            //     const data = new Float32Array(size * size);
            //     for (let i = 0; i < size; i++) {
            //         for (let j = 0; j < size; j++) {
            //             data[i + j * size] = i % 2 == 0 & j % 2== 0 ? 1.0 : 0.0;
            //         }
            //     }
            //     this.textures[k] = this.createTexture(data);
            //     // *Next is needed for when * needs to update itself, e.g. with setBoundary
            //     this.textures[`${k}Next`] = this.createTexture(data);
            // } else {
            //     this.textures[k] = this.createTexture(new Float32Array(size * size));
            //     // *Next is needed for when * needs to update itself, e.g. with setBoundary
            //     this.textures[`${k}Next`] = this.createTexture(new Float32Array(size * size));
            // }

            this.textures[k] = this.createTexture(new Float32Array(size * size));
            // *Next is needed for when * needs to update itself, e.g. with setBoundary
            this.textures[`${k}Next`] = this.createTexture(new Float32Array(size * size));
        });
    }

    createTexture(data, internalFormat, format) {
        const { gl, size } = this;

        // internal format e.g. R32F, RGBA, etc.
        // format e.g. RED, RG, RGBA, etc.
        // defaults
        if (!internalFormat) {
            internalFormat = gl.R32F;
        }
        if (!format) {
            format = gl.RED;
        }

        // only supporting these floats for now.
        if (internalFormat !== gl.R32F && internalFormat !== gl.RG32F) {
            throw new Error("Invalid internal format");
        }
        if (format !== gl.RED && format !== gl.RG) {
            throw new Error("Invalid format");
        }

        if (!(data instanceof Float32Array)) {
            if (data !== null) {
            // data must be Float32Array or null to use it with gl.R32F.
                throw new Error("Invalid data type.");
            }
        }

        const texture = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
        gl.texImage2D(
            gl.TEXTURE_2D,
            0,
            internalFormat,
            size,
            size,
            0,
            format,
            gl.FLOAT,
            data
        );
        // Needed for texture completeness, no clamping and gl.NEAREST is the only
        // filtering mode available for R32F.
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        gl.bindTexture(gl.TEXTURE_2D, null);
        return texture;
    }

    // Prefer 'copyPixels' to 'readPixels' + 'fillTexture'.
    // fillTexture(texture, data) {
    //     const { gl, size } = this;
    //     if (!(data instanceof Float32Array)) {
    //         if (data !== null) {
    //         // data must be Float32Array or null to use it with gl.R32F.
    //             throw new Error("Invalid data type.");
    //         }
    //     }

    //     gl.bindTexture(gl.TEXTURE_2D, texture);
    //     gl.texImage2D(
    //         gl.TEXTURE_2D,
    //         0,
    //         gl.R32F,
    //         size,
    //         size,
    //         0,
    //         gl.RED,
    //         gl.FLOAT,
    //         data
    //     );
    //     // Needed for texture completeness, no clamping and gl.NEAREST is the only
    //     // filtering mode available for R32F.
    //     gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    //     gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    //     gl.bindTexture(gl.TEXTURE_2D, null);
    // }

    createFramebuffer() {
        const { gl } = this;
        const fb = gl.createFramebuffer();
        gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
        this.fb = fb;
    }

    setFramebufferTexture(texture) {
        const { gl, fb } = this;
        gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
        gl.framebufferTexture2D(
            gl.FRAMEBUFFER, 
            gl.COLOR_ATTACHMENT0, 
            gl.TEXTURE_2D, 
            texture,
            0
        );
        // Slow to do this because we need to query the gpu state. Leave it only for debugging.
        if (DEBUG) {
            if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
                console.log('completeness', gl.checkFramebufferStatus(gl.FRAMEBUFFER), gl.FRAMEBUFFER_COMPLETE);
                console.log(gl.FRAMEBUFFER_COMPLETE);
                console.log(gl.FRAMEBUFFER_INCOMPLETE_ATTACHMENT);
                console.log(gl.FRAMEBUFFER_INCOMPLETE_MISSING_ATTACHMENT);
                return;
            }
        }
    }

    addFanDensityForces(sourceDensity) {
        const { gl } = this;
        {
            const sourceTex = this.textures.x;
            const targetTex = this.textures.xNext;

            this.setFramebufferTexture(targetTex);

            gl.clear(gl.COLOR_BUFFER_BIT);
            
            gl.useProgram(this.shaders.addFanDensity.program);

            gl.activeTexture(gl.TEXTURE0);
            gl.uniform1i(this.shaders.addFanDensity.u_xLocation, 0);
            gl.bindTexture(gl.TEXTURE_2D, sourceTex);

            gl.uniform1f(this.shaders.addFanDensity.u_source_densityLocation, sourceDensity);

            this.quad.draw(gl);

            gl.bindFramebuffer(gl.FRAMEBUFFER, null);

            this.textures.x = targetTex;
            this.textures.xNext = sourceTex;
        }
        {
            const sourceTex = this.textures.u;
            const targetTex = this.textures.uNext;

            this.setFramebufferTexture(targetTex);

            gl.clear(gl.COLOR_BUFFER_BIT);
            
            gl.useProgram(this.shaders.addFanVelocity.program);

            gl.activeTexture(gl.TEXTURE0);
            gl.uniform1i(this.shaders.addFanVelocity.u_xLocation, 0);
            gl.bindTexture(gl.TEXTURE_2D, sourceTex);

            this.quad.draw(gl);

            gl.bindFramebuffer(gl.FRAMEBUFFER, null);

            this.textures.u = targetTex;
            this.textures.uNext = sourceTex;
        }
    }

    addMouseDensityForces(sourceDensity, target, xVelocity, yVelocity) {
        const { gl } = this;
        {
            const sourceTex = this.textures.x;
            const targetTex = this.textures.xNext;

            this.setFramebufferTexture(targetTex);

            gl.clear(gl.COLOR_BUFFER_BIT);
            
            gl.useProgram(this.shaders.addMouseDensity.program);

            gl.activeTexture(gl.TEXTURE0);
            gl.uniform1i(this.shaders.addMouseDensity.u_xLocation, 0);
            gl.bindTexture(gl.TEXTURE_2D, sourceTex);

            gl.uniform1f(this.shaders.addMouseDensity.u_source_densityLocation, sourceDensity);
            gl.uniform2iv(this.shaders.addMouseDensity.u_targetLocation, target);

            this.quad.draw(gl);

            gl.bindFramebuffer(gl.FRAMEBUFFER, null);

            this.textures.x = targetTex;
            this.textures.xNext = sourceTex;
        }
        // TODO
        // Combine u and v into one pass.
        {
            const sourceTex = this.textures.u;
            const targetTex = this.textures.uNext;

            this.setFramebufferTexture(targetTex);

            gl.clear(gl.COLOR_BUFFER_BIT);
            
            gl.useProgram(this.shaders.addMouseVelocity.program);

            gl.activeTexture(gl.TEXTURE0);
            gl.uniform1i(this.shaders.addMouseVelocity.u_uvLocation, 0);
            gl.bindTexture(gl.TEXTURE_2D, sourceTex);

            gl.uniform2iv(this.shaders.addMouseVelocity.u_targetLocation, target);
            gl.uniform1f(this.shaders.addMouseVelocity.u_velocityLocation, xVelocity);

            this.quad.draw(gl);

            gl.bindFramebuffer(gl.FRAMEBUFFER, null);

            this.textures.u = targetTex;
            this.textures.uNext = sourceTex;
        }
        {
            const sourceTex = this.textures.v;
            const targetTex = this.textures.vNext;

            this.setFramebufferTexture(targetTex);

            gl.clear(gl.COLOR_BUFFER_BIT);
            
            gl.useProgram(this.shaders.addMouseVelocity.program);

            gl.activeTexture(gl.TEXTURE0);
            gl.uniform1i(this.shaders.addMouseVelocity.u_uvLocation, 0);
            gl.bindTexture(gl.TEXTURE_2D, sourceTex);

            gl.uniform2iv(this.shaders.addMouseVelocity.u_targetLocation, target);
            gl.uniform1f(this.shaders.addMouseVelocity.u_velocityLocation, yVelocity);

            this.quad.draw(gl);

            gl.bindFramebuffer(gl.FRAMEBUFFER, null);

            this.textures.v = targetTex;
            this.textures.vNext = sourceTex;
        }
    }

    solveLinear(x, x0, a, c) {
        // x is target, x0 is source.
        const { gl } = this;

        const xTex = this.textures[x];
        const x0Tex = this.textures[x0];

        const xTexNext = this.textures[`${x}Next`];
        this.setFramebufferTexture(xTexNext);

        gl.clear(gl.COLOR_BUFFER_BIT);
        
        gl.useProgram(this.shaders.solveLinear.program);

        gl.activeTexture(gl.TEXTURE0);
        gl.uniform1i(this.shaders.solveLinear.u_xLocation, 0);
        gl.bindTexture(gl.TEXTURE_2D, xTex);

        gl.activeTexture(gl.TEXTURE1);
        gl.uniform1i(this.shaders.solveLinear.u_x0Location, 1);
        gl.bindTexture(gl.TEXTURE_2D, x0Tex);

        gl.uniform1f(this.shaders.solveLinear.u_aLocation, a);
        gl.uniform1f(this.shaders.solveLinear.u_cLocation, c);

        this.quad.draw(gl);

        gl.bindFramebuffer(gl.FRAMEBUFFER, null);

        this.textures[x] = xTexNext;
        this.textures[`${x}Next`] = xTex;
    }

    divergence(h, target, u, v) {
        const { gl } = this;

        const uTex = this.textures[u];
        const vTex = this.textures[v];

        const targetTex = this.textures[target];
        this.setFramebufferTexture(targetTex);

        gl.clear(gl.COLOR_BUFFER_BIT);
        
        gl.useProgram(this.shaders.divergence.program);

        gl.activeTexture(gl.TEXTURE0);
        gl.uniform1i(this.shaders.divergence.u_uLocation, 0);
        gl.bindTexture(gl.TEXTURE_2D, uTex);

        gl.activeTexture(gl.TEXTURE1);
        gl.uniform1i(this.shaders.divergence.u_vLocation, 1);
        gl.bindTexture(gl.TEXTURE_2D, vTex);

        gl.uniform1f(this.shaders.divergence.u_hLocation, h);

        this.quad.draw(gl);

        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    }

    velocity(h, uv, p, direction) {
        // todo
        // should combine u and v into one.
        const { gl } = this;

        const uvTex = this.textures[uv];
        const pTex = this.textures[p];

        const uvTexNext = this.textures[`${uv}Next`];
        this.setFramebufferTexture(uvTexNext);

        gl.clear(gl.COLOR_BUFFER_BIT);
        
        gl.useProgram(this.shaders.velocity.program);

        gl.activeTexture(gl.TEXTURE0);
        gl.uniform1i(this.shaders.velocity.u_uvLocation, 0);
        gl.bindTexture(gl.TEXTURE_2D, uvTex);

        gl.activeTexture(gl.TEXTURE1);
        gl.uniform1i(this.shaders.velocity.u_pLocation, 1);
        gl.bindTexture(gl.TEXTURE_2D, pTex);

        gl.uniform1f(this.shaders.velocity.u_hLocation, h);
        gl.uniform1i(this.shaders.velocity.u_directionLocation, direction);

        this.quad.draw(gl);

        gl.bindFramebuffer(gl.FRAMEBUFFER, null);

        this.textures[uv] = uvTexNext;
        this.textures[`${uv}Next`] = uvTex;
    }

    advect(dt0, target, source, u, v) {
        const { gl } = this;

        const sourceTex = this.textures[source];
        const uTex = this.textures[u];
        const vTex = this.textures[v];

        const targetTex = this.textures[target];
        this.setFramebufferTexture(targetTex);
        
        gl.clear(gl.COLOR_BUFFER_BIT);
        
        gl.useProgram(this.shaders.advect.program);

        gl.activeTexture(gl.TEXTURE0);
        gl.uniform1i(this.shaders.advect.u_sourceLocation, 0);
        gl.bindTexture(gl.TEXTURE_2D, sourceTex);

        gl.activeTexture(gl.TEXTURE1);
        gl.uniform1i(this.shaders.advect.u_uLocation, 1);
        gl.bindTexture(gl.TEXTURE_2D, uTex);

        gl.activeTexture(gl.TEXTURE2);
        gl.uniform1i(this.shaders.advect.u_vLocation, 2);
        gl.bindTexture(gl.TEXTURE_2D, vTex);

        gl.uniform1f(this.shaders.advect.u_dt0Location, dt0);
        this.quad.draw(gl);

        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    }

    setBoundary(target, boundary) {
        const { gl } = this;

        const xTex = this.textures[target];

        const xTexNext = this.textures[`${target}Next`];
        this.setFramebufferTexture(xTexNext);

        gl.clear(gl.COLOR_BUFFER_BIT);
        
        gl.useProgram(this.shaders.setBoundary.program);

        gl.activeTexture(gl.TEXTURE0);
        gl.uniform1i(this.shaders.setBoundary.u_xLocation, 0);
        gl.bindTexture(gl.TEXTURE_2D, xTex);

        gl.uniform1i(this.shaders.setBoundary.u_bLocation, boundary);
        this.quad.draw(gl);

        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        this.textures[target] = xTexNext;
        this.textures[`${target}Next`] = xTex;
    }

    fade(densityDecay) {
        const { gl } = this;
        const sourceTex = this.textures.x;
        const targetTex = this.textures.xNext;

        this.setFramebufferTexture(targetTex);

        gl.clear(gl.COLOR_BUFFER_BIT);
        
        gl.useProgram(this.shaders.fade.program);

        gl.activeTexture(gl.TEXTURE0);
        gl.uniform1i(this.shaders.fade.u_xLocation, 0);
        gl.bindTexture(gl.TEXTURE_2D, sourceTex);

        gl.uniform1f(this.shaders.fade.u_density_decayLocation, densityDecay);

        this.quad.draw(gl);

        gl.bindFramebuffer(gl.FRAMEBUFFER, null);

        this.textures.x = targetTex;
        this.textures.xNext = sourceTex;
    }

    render(source) {
        const { gl } = this;

        // default renderbuffer.
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);

        gl.clear(gl.COLOR_BUFFER_BIT);
        
        gl.useProgram(this.shaders.render.program);

        gl.activeTexture(gl.TEXTURE0);
        gl.uniform1i(this.shaders.render.u_xLocation, 0);
        gl.bindTexture(gl.TEXTURE_2D, this.textures[source]);

        this.quad.draw(gl);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    }
    
    copyPixels(source, target) {
        // Replaces:
        // const pixels = this.readPixels(source);
        // pixels.forEach((p , i) => state[target][i] = p);
        // this.fillTexture(this.textures[target], pixels);
        // Since we don't need to make the context switch and copy all the data
        // out of GPU memory.

        if (source === target) {
            throw new Error("Can't copy to self.");
        }

        const { gl, fb, size } = this;
        gl.bindFramebuffer(gl.FRAMEBUFFER, fb);

        const sourceTex = this.textures[source];
        const targetTex = this.textures[target];

        this.setFramebufferTexture(sourceTex);
        gl.bindTexture(gl.TEXTURE_2D, targetTex);

        gl.copyTexImage2D(gl.TEXTURE_2D, 0, gl.R32F, 0, 0, size, size, 0);

        gl.bindTexture(gl.TEXTURE_2D, null);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    }

    // Prefer 'copyPixels' to 'readPixels' + 'fillTexture'.
    // readPixels(textureKey) {
    //     const { gl, size, fb } = this;
    //     gl.bindFramebuffer(gl.READ_FRAMEBUFFER, fb);
    //     if (textureKey) {
    //         this.setFramebufferTexture(this.textures[textureKey]);
    //     }

    //     const tmp = new Float32Array(size * size * 4);
    //     gl.readPixels(0, 0, size, size, gl.RGBA, gl.FLOAT, tmp);
    //     const ret = new Float32Array(size * size);
    //     for (let i = 0; i < ret.length; i++) {
    //         ret[i] = tmp[i * 4];
    //     }

    //     gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
    //     return ret;
    // }
}

export { GL };
