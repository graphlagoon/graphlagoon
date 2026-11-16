import type * as THREE from 'three';

/** The orthographic (2D) camera's frustum height in world units at zoom 1 (useGraphCamera). */
export const ORTHO_FRUSTUM = 2000;

/**
 * Screen pixels per world unit at the orbit target: exact for the 2D
 * (orthographic) view, at the target's depth for 3D. 1 when unknown.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function pixelsPerWorldUnit(graph3d: any): number {
  const cam = graph3d?.camera?.() as (THREE.Camera & { zoom?: number; isOrthographicCamera?: boolean; fov?: number }) | undefined;
  if (!cam) return 1;
  const vh: number = graph3d.renderer?.()?.domElement?.clientHeight || 600;
  if (cam.isOrthographicCamera && cam.zoom) return (vh * cam.zoom) / ORTHO_FRUSTUM;
  const target = graph3d.controls?.()?.target;
  if (!target || !cam.fov) return 1;
  const dist = cam.position.distanceTo(target);
  return vh / 2 / (dist * Math.tan(((cam.fov / 2) * Math.PI) / 180));
}

/** Below this diameter on screen an icon node is drawn as a plain dot (its glyph would be noise). */
export const ICON_DOT_BELOW_PX = 7;
/** …and it becomes an icon again only above this one, so a camera resting at the threshold does not flicker. */
export const ICON_BACK_ABOVE_PX = 9;

/** Dot or icon for a node `diameterPx` wide on screen, given what it was drawn as. */
export function drawAsDot(diameterPx: number, wasDot: boolean): boolean {
  return wasDot ? diameterPx < ICON_BACK_ABOVE_PX : diameterPx < ICON_DOT_BELOW_PX;
}
