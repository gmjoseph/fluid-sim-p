import { GL } from './gl.js';

/* 
 * http://jamie-wong.com/2016/08/05/webgl-fluid-simulation + https://codepen.io/davvidbaker/pen/ENbqdQ
 * https://gamedev.net/forums/topic/579139-jacobi-for-solving-fluid-pressure/4689826/
 * https://www.shadertoy.com/view/MdSczK
 * https://developer.nvidia.com/gpugems/gpugems/part-vi-beyond-triangles/chapter-38-fast-fluid-dynamics-simulation-gpu
 * https://github.com/Janh2978/Real_time_Fluid_Simulation
 * 
 * Learnings
 * * Gauss-seidel is no good in gpu computation because it relies on mutated original values
 *   as part of computing the next value.
 * 
 * * Finding out how to use diffuse and viscosity params with the jacobi method never worked
 *   out for me. Would be nice to go back and find that out, or try out the conjugate gradient
 *   method.
 * 
 * * R32 needs extensions, and using an extension is just a matter of querying for it it seems.
 * 
 * * It's hard to debug/develop using the method of writing to and from textures. Best to do it
 *   incrementally. It's even worse if we need to do manipulations directly on the pixelbuffers
 *   outside of shaders (like updating the decay or adding forces). At the time of writing this,
 *   there are still outside writes/reads (i.e. readPixels, textImage2d updates), happening 'out
 *   -of-band' (i.e. not within a shader computation). These are a serious drag on performance,
 *   since we need to grab data all the way from gpu memory (or put more data there), which
 *   profiling shows to be slow.
 *
 */

const FPS = 1/60;
// cell size, this is the 'N' throughout the paper.
// 1280 is a good limit. 1400 seems to be a struggle.
const N = 1024;
// cell size accounting for the edge boundary cells added
const CSB = N + 2;
// amount of cells we need to allocate. we add 2 to account
// for boundary cells in the left, top, bottom, and right of
// the grid.
const SIZE = (CSB) ** 2;
// the boundary is always there in the data, but we may not want to
// show the boundary cells + their data at draw time.
const VIZ_BOUNDARY = true;

const MODES = {
    Fan: 0,
    Mouse: 1,
    Dual: 2,
    // todo
    // Automatically input mouse coordintes - not implemented yet.
    // MouseAuto: 3,
};
const MODE = MODES.Dual;

// todo
// pass viz_boundary to render shader?

let gpu = null;
let gpuError = null;
try {
    gpu = new GL(CSB, MODE);
} catch (e) {
    gpuError = e;
}

const state = {
    // How quickly to make the thing dissipate. If it's 0, all the densities we introduce
    // will stick around and be moved along the force field, meaning nothing will ever
    // fade away in the simulation. Simulating smoke definitely requires a positive fade rate.
    densityDecay: 0.02,
    // When adding a source density with the mouse, how much density should be added.
    sourceDensity: 10,
    mouseDown: false,
    // Previous mouse coordinates to drive the force field / potentially densities?
    mouse0: null,
    // Current mouse, to sample on each loop of the simulator.
    mouse: null,
};

function solveLinearJacobi(xk, x0k, boundary, a, c) {   
    for (let k = 0; k < 20; k++) {
        // notice that we only do this on non-boundary cells so we can sample the boundary.
        gpu.solveLinear(xk, x0k, a, c);
        gpu.setBoundary(xk, boundary);
    }
}

function diffuse(target, source, boundary) {
    // TODO
    // we should write a passthrough shader or somehow write to two targets here,
    // otherwise we need to keep the textures and state in sync.
    // maybe better is:
    // https://developer.mozilla.org/en-US/docs/Web/API/WebGLRenderingContext/copyTexImage2D
    gpu.setBoundary(source, boundary);
    gpu.copyPixels(source, target);
}

function advect(dt, target, source, u, v, boundary) {
    // uses a 'simple linear backtrace' to compute density diffusion
    const dt0 = dt * N;
    gpu.advect(dt0, target, source, u, v, boundary);
    gpu.setBoundary(target, boundary);
}

function project(u, v, p, div) {
    // the paper assumes the grid is normalized, so it can get a spacing of the grid using 1 / N (i.e.
    // edge length / count of cells), but we already know that the spacing is width or height / N.
    // however i'm not sure how much this matters...
    const h = N;
    gpu.divergence(h, div, u, v);
    gpu.setBoundary(div, 0);

    gpu.setBoundary(p, 0);    
    solveLinearJacobi(p, div, 0, 1, 4);

    // TODO
    // combine into one uv
    gpu.velocity(h, u, p, 0);
    gpu.velocity(h, v, p, 1);

    gpu.setBoundary(u, 1);
    gpu.setBoundary(v, 2);
}

function densityStep(dt) {
    diffuse('x0', 'x', 0);
    // combines what we did in the velocity step with what we're doing in the
    // density step. i.e. this is the only touch point between the density
    // and the velocity vector field.
    advect(dt, 'x', 'x0', 'u', 'v', 0);
}

function velocityStep(dt) {
    diffuse('u0', 'u', 1);
    diffuse('v0', 'v', 2);
    project('u0', 'v0', 'u', 'v')
    advect(dt, 'u', 'u0', 'u0', 'v0', 1);
    advect(dt, 'v', 'v0', 'u0', 'v0', 2);
    project('u', 'v', 'u0', 'v0')
}

function addMouseDensityForces() {
    if (!state.mouseDown || !state.mouse0) {
        return;
    }
    const { cx , cy } = getCoords(state.mouse);
    const { cx: pcx, cy: pcy } = getCoords(state.mouse0);
    const xv = cx - pcx;
    const yv = cy - pcy;

    gpu.addMouseDensityForces(state.sourceDensity, [cx, cy], xv, yv);
}

function update(dt) {
    if (MODE === MODES.Fan || MODE === MODES.Dual) {
        gpu.addFanDensityForces(state.sourceDensity);
    }
    if (MODE === MODES.Mouse || MODE === MODES.Dual || MODE === MODES.MouseAuto) {
        addMouseDensityForces();
    }
    // the equation we deal with states (figure 1 for density, right to left)
    // 1. density follows velocity field
    // 2. density diffuses at certain rate
    // 3. density increases due to sources (the + S)
    // we solve it in reverse (add sources, diffuse, follow the velocity field)
    velocityStep(dt);
    densityStep(dt);
    gpu.fade(state.densityDecay);
}

function getCoords(e) {
    const rect = e.target.getBoundingClientRect();
    const cx = (e.clientX - rect.left);
    const cy = (e.clientY - rect.top);

    // For when the canvas isn't rotated 90deg.
    // // We want to use these in the gl sense, so we flip them on the y axis
    // // because its a bottom left coord system whereas this is top left.
    // const tcx = cx;
    // const tcy = e.target.height - cy;
    // // 1026, 0 maps to 1026, 1026
    // // 1026, 1026 maps to 1026, 0
    // return { cx: tcx, cy: tcy };

    // For when the canvas is rotated 90deg, we can just flip
    // the coordinates.
    // We want to use these in the gl sense, so we flip them on the y axis
    // because its a bottom left coord system whereas this is top left.
    return { cx: cy, cy: cx };
}

function setupHandlers() {
    const canvas = document.getElementById('canvas');
    const moveHandler = (e) => {
        if (!state.mouse0) {
            state.mouse0 = e;
        }
        state.mouse0 = state.mouse;
        state.mouse = e;
    };
    canvas.onmousedown = () => state.mouseDown = true;
    canvas.onmousemove = moveHandler;
    canvas.onmouseup = () => state.mouseDown = false;
}

function loop() {
    const run = (t) => {
        update(FPS);
        gpu.render('x');
        requestAnimationFrame(run);
    }
    requestAnimationFrame(run)
}

// function loopMouseAuto() {
//     const mouseMoves = []
//     const run = (t) => {
//         const cy = canvas.clientY;

//         update(FPS);
//         gpu.render('x');
//         requestAnimationFrame(run);
//     }
//     requestAnimationFrame(run)
// }

function main() {
    if (!gpu) {
        alert(gpuError ? gpuError : "Failed to init webgl")
        return;
    }

    setupHandlers();
    
    if (MODE === MODES.Fan) {
        state.densityDecay = 0.1;
        state.sourceDensity = 5;
        loop();
    }
    
    if (MODE === MODES.Mouse) {
        state.densityDecay = 0.00002;
        state.sourceDensity = 12;
        loop();
    }
    
    if (MODE === MODES.Dual) {
        state.densityDecay = 0.00002;
        state.sourceDensity = 12;
        loop();
    }

    // if (MODE === MODES.MouseAuto) {
    //     state.densityDecay = 0.00002;
    //     state.sourceDensity = 12;
    //     loopMouseAuto();
    // }
}

main();

