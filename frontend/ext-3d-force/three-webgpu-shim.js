// Shim to prevent loading the full three/webgpu build (which duplicates Three.js).
// We only use WebGL — WebGPURenderer is imported by three-render-objects but never used.
export class WebGPURenderer {}
