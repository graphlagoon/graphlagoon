import { AmbientLight, DirectionalLight, Vector3, Vector2, Raycaster, Plane, REVISION } from 'three';

const three = window.THREE
  ? window.THREE // Prefer consumption from global THREE, if exists
  : { AmbientLight, DirectionalLight, Vector3, Vector2, Raycaster, Plane, REVISION };

import ThreeForceGraph from 'three-forcegraph';
import ThreeRenderObjects from 'three-render-objects';

import accessorFn from 'accessor-fn';
import Kapsule from 'kapsule';

import linkKapsule from './kapsule-link.js';

//

const CAMERA_DISTANCE2NODES_FACTOR = 170;

//

// Expose config from forceGraph
const bindFG = linkKapsule('forceGraph', ThreeForceGraph);
const linkedFGProps = Object.assign(...[
  'jsonUrl',
  'graphData',
  'numDimensions',
  'dagMode',
  'dagLevelDistance',
  'dagNodeFilter',
  'onDagError',
  'nodeRelSize',
  'nodeId',
  'nodeVal',
  'nodeResolution',
  'nodeColor',
  'nodeAutoColorBy',
  'nodeOpacity',
  'nodeVisibility',
  'nodeThreeObject',
  'nodeThreeObjectExtend',
  'nodePositionUpdate',
  'linkSource',
  'linkTarget',
  'linkVisibility',
  'linkColor',
  'linkAutoColorBy',
  'linkOpacity',
  'linkWidth',
  'linkResolution',
  'linkCurvature',
  'linkCurveRotation',
  'linkMaterial',
  'linkThreeObject',
  'linkThreeObjectExtend',
  'linkPositionUpdate',
  'linkDirectionalArrowLength',
  'linkDirectionalArrowColor',
  'linkDirectionalArrowRelPos',
  'linkDirectionalArrowResolution',
  'linkDirectionalParticles',
  'linkDirectionalParticleSpeed',
  'linkDirectionalParticleOffset',
  'linkDirectionalParticleWidth',
  'linkDirectionalParticleColor',
  'linkDirectionalParticleResolution',
  'linkDirectionalParticleThreeObject',
  'useInstancedRendering',
  'forceEngine',
  'd3AlphaDecay',
  'd3VelocityDecay',
  'd3AlphaMin',
  'ngraphPhysics',
  'warmupTicks',
  'cooldownTicks',
  'cooldownTime',
  'ticksPerFrame',
  'onEngineTick',
  'onEngineStop'
].map(p => ({ [p]: bindFG.linkProp(p)})));
const linkedFGMethods = Object.assign(...[
  'refresh',
  'getGraphBbox',
  'd3Force',
  'd3ReheatSimulation',
  'emitParticle'
].map(p => ({ [p]: bindFG.linkMethod(p)})));

// Expose config from renderObjs
const bindRenderObjs = linkKapsule('renderObjs', ThreeRenderObjects);
const linkedRenderObjsProps = Object.assign(...[
  'width',
  'height',
  'backgroundColor',
  'showNavInfo',
  'enablePointerInteraction'
].map(p => ({ [p]: bindRenderObjs.linkProp(p)})));
const linkedRenderObjsMethods = Object.assign(
  ...[
    'lights',
    'cameraPosition',
    'postProcessingComposer'
  ].map(p => ({ [p]: bindRenderObjs.linkMethod(p)})),
  {
    graph2ScreenCoords: bindRenderObjs.linkMethod('getScreenCoords'),
    screen2GraphCoords: bindRenderObjs.linkMethod('getSceneCoords')
  }
);

//

export default Kapsule({

  props: {
    nodeLabel: { default: 'name', triggerUpdate: false },
    linkLabel: { default: 'name', triggerUpdate: false },
    linkHoverPrecision: { default: 1, onChange: (p, state) => state.renderObjs.lineHoverPrecision(p), triggerUpdate: false },
    enableNavigationControls: {
      default: true,
      onChange(enable, state) {
        const controls = state.renderObjs.controls();
        if (controls) {
          controls.enabled = enable;
          // trigger mouseup on re-enable to prevent sticky controls
          enable && controls.domElement && controls.domElement.dispatchEvent(new PointerEvent('pointerup'));
        }
      },
      triggerUpdate: false
    },
    enableNodeDrag: { default: true, triggerUpdate: false },
    onNodeDrag: { default: () => {}, triggerUpdate: false },
    onNodeDragEnd: { default: () => {}, triggerUpdate: false },
    onNodeClick: { triggerUpdate: false },
    onNodeRightClick: { triggerUpdate: false },
    onNodeHover: { triggerUpdate: false },
    onLinkClick: { triggerUpdate: false },
    onLinkRightClick: { triggerUpdate: false },
    onLinkHover: { triggerUpdate: false },
    onBackgroundClick: { triggerUpdate: false },
    onBackgroundRightClick: { triggerUpdate: false },
    showPointerCursor: { default: true, triggerUpdate: false },
    ...linkedFGProps,
    ...linkedRenderObjsProps
  },

  methods: {
    zoomToFit: function(state, transitionDuration, padding, ...bboxArgs) {
      state.renderObjs.fitToBbox(
        state.forceGraph.getGraphBbox(...bboxArgs),
        transitionDuration,
        padding
      );
      return this;
    },
    pauseAnimation: function(state) {
      if (state.animationFrameRequestId !== null) {
        cancelAnimationFrame(state.animationFrameRequestId);
        state.animationFrameRequestId = null;
      }
      return this;
    },

    resumeAnimation: function(state) {
      if (state.animationFrameRequestId === null) {
        this._animationCycle();
      }
      return this;
    },
    _animationCycle(state) {
      if (state.enablePointerInteraction) {
        // reset canvas cursor (override drag cursor)
        this.renderer().domElement.style.cursor = null;
      }

      // Frame cycle
      state.forceGraph.tickFrame(state.renderObjs.camera());
      state.renderObjs.tick();
      state.animationFrameRequestId = requestAnimationFrame(this._animationCycle);
    },
    scene: state => state.renderObjs.scene(), // Expose scene
    camera: state => state.renderObjs.camera(), // Expose camera
    renderer: state => state.renderObjs.renderer(), // Expose renderer
    controls: state => state.renderObjs.controls(), // Expose controls
    tbControls: state => state.renderObjs.tbControls(), // To be deprecated
    _destructor: function() {
      this.pauseAnimation();
      this.graphData({ nodes: [], links: []});
    },
    ...linkedFGMethods,
    ...linkedRenderObjsMethods
  },

  stateInit: ({ controlType, rendererConfig, extraRenderers }) => {
    const forceGraph = new ThreeForceGraph();
    return {
      forceGraph,
      renderObjs: ThreeRenderObjects({ controlType, rendererConfig, extraRenderers })
        .objects([forceGraph]) // Populate scene
        .lights([
          new three.AmbientLight(0xcccccc, Math.PI),
          new three.DirectionalLight(0xffffff, 0.6 * Math.PI)
        ])
    }
  },

  init: function(domNode, state) {
    // Wipe DOM
    domNode.innerHTML = '';

    // Add relative container
    domNode.appendChild(state.container = document.createElement('div'));
    state.container.style.position = 'relative';

    // Add renderObjs
    const roDomNode = document.createElement('div');
    state.container.appendChild(roDomNode);
    state.renderObjs(roDomNode);
    const camera = state.renderObjs.camera();
    const renderer = state.renderObjs.renderer();
    const controls = state.renderObjs.controls();
    controls.enabled = !!state.enableNavigationControls;
    state.lastSetCameraZ = camera.position.z;

    // Add info space
    let infoElem;
    state.container.appendChild(infoElem = document.createElement('div'));
    infoElem.className = 'graph-info-msg';
    infoElem.textContent = '';

    // config forcegraph
    state.forceGraph
      .onLoading(() => { infoElem.textContent = 'Loading...' })
      .onFinishLoading(() => { infoElem.textContent = '' })
      .onUpdate(() => {
        // sync graph data structures
        state.graphData = state.forceGraph.graphData();

        // re-aim camera, if still in default position (not user modified)
        if (camera.position.x === 0 && camera.position.y === 0 && camera.position.z === state.lastSetCameraZ && state.graphData.nodes.length) {
          camera.lookAt(state.forceGraph.position);
          state.lastSetCameraZ = camera.position.z = Math.cbrt(state.graphData.nodes.length) * CAMERA_DISTANCE2NODES_FACTOR;
        }
      })
      .onFinishUpdate(() => {
        // Setup custom node drag (replaces DragControls for InstancedMesh support)
        setupInstancedDrag(state, camera, renderer, controls);
      });

    // config renderObjs
    three.REVISION < 155 && (state.renderObjs.renderer().useLegacyLights = false); // force behavior for three < 155
    state.renderObjs
      .hoverOrderComparator((a, b) => {
        // Prioritize graph objects
        const aObj = getGraphObj(a);
        if (!aObj) return 1;
        const bObj = getGraphObj(b);
        if (!bObj) return -1;

        // Prioritize nodes over links
        const isNode = o => o.__graphObjType === 'node';
        return isNode(bObj) - isNode(aObj);
      })
      .tooltipContent((obj, intersection) => {
        const graphObj = getGraphObj(obj, intersection);
        return graphObj ? accessorFn(state[`${graphObj.__graphObjType}Label`])(graphObj.__data) || '' : '';
      })
      .hoverDuringDrag(false)
      .onHover((obj, prevObj, intersection) => {
        // Update tooltip and trigger onHover events
        const hoverObj = getGraphObj(obj, intersection);

        if (hoverObj !== state.hoverObj) {
          const prevObjType = state.hoverObj ? state.hoverObj.__graphObjType : null;
          const prevObjData = state.hoverObj ? state.hoverObj.__data : null;
          const objType = hoverObj ? hoverObj.__graphObjType : null;
          const objData = hoverObj ? hoverObj.__data : null;
          if (prevObjType && prevObjType !== objType) {
            // Hover out
            const fn = state[`on${prevObjType === 'node' ? 'Node' : 'Link'}Hover`];
            fn && fn(null, prevObjData);
          }
          if (objType) {
            // Hover in
            const fn = state[`on${objType === 'node' ? 'Node' : 'Link'}Hover`];
            fn && fn(objData, prevObjType === objType ? prevObjData : null);
          }

          // set pointer if hovered object is clickable
          renderer.domElement.classList[
            ((hoverObj && state[`on${objType === 'node' ? 'Node' : 'Link'}Click`]) || (!hoverObj && state.onBackgroundClick)) &&
            accessorFn(state.showPointerCursor)(objData) ? 'add' : 'remove'
          ]('clickable');

          state.hoverObj = hoverObj;
        }
      })
      .clickAfterDrag(false)
      .onClick((obj, ev, intersection) => {
        // Skip if drag just ended
        if (state._dragJustEnded) {
          state._dragJustEnded = false;
          return;
        }
        const graphObj = getGraphObj(obj, intersection);
        if (graphObj) {
          const fn = state[`on${graphObj.__graphObjType === 'node' ? 'Node' : 'Link'}Click`];
          fn && fn(graphObj.__data, ev);
        } else {
          state.onBackgroundClick && state.onBackgroundClick(ev);
        }
      })
      .onRightClick((obj, ev, intersection) => {
        // Handle right-click events
        const graphObj = getGraphObj(obj, intersection);
        if (graphObj) {
          const fn = state[`on${graphObj.__graphObjType === 'node' ? 'Node' : 'Link'}RightClick`];
          fn && fn(graphObj.__data, ev);
        } else {
          state.onBackgroundRightClick && state.onBackgroundRightClick(ev);
        }
      });

    //

    // Kick-off renderer
    this._animationCycle();
  }
});

//

/**
 * Resolve a raycasted Three.js object to a graph object.
 * Handles both individual meshes (custom nodes) and InstancedMesh (instanced nodes/links).
 */
function getGraphObj(object, intersection) {
  if (!object) return null;

  // Walk up the parent chain to find an object with __graphObjType
  let obj = object;
  while (obj && !obj.hasOwnProperty('__graphObjType')) {
    obj = obj.parent;
  }

  if (!obj) return null;

  // If this is an instanced renderer, resolve the specific instance data
  if (obj.__isInstancedRenderer && intersection && intersection.instanceId !== undefined) {
    const renderer = obj.__instancedRenderer;
    const data = renderer.getDataByInstanceId(intersection.instanceId);
    if (data) {
      // Return a virtual graph object proxy with the same interface
      return {
        __graphObjType: obj.__graphObjType,
        __data: data,
        __instanceId: intersection.instanceId,
        __instancedRenderer: renderer,
      };
    }
    return null;
  }

  return obj;
}

/**
 * Custom drag system for InstancedMesh + individual mesh nodes.
 * Replaces Three.js DragControls which requires individual mesh objects.
 */
function setupInstancedDrag(state, camera, renderer, controls) {
  // Clean up previous drag handlers
  if (state._dragCleanup) {
    state._dragCleanup();
  }

  if (!state.enableNodeDrag || !state.enablePointerInteraction || state.forceEngine !== 'd3') {
    return;
  }

  let dragging = false;
  let dragNode = null;
  let pendingDragNode = null; // node under pointer on pointerdown, before drag threshold
  let pendingDragHit = null;  // hit info for pending drag
  let pointerDownPos = null;  // screen coords at pointerdown for threshold check
  const DRAG_THRESHOLD = 4;   // pixels of movement before drag starts
  const dragPlane = new three.Plane();
  const dragOffset = new three.Vector3();
  const dragIntersection = new three.Vector3();
  const raycaster = new three.Raycaster();
  const pointer = new three.Vector2();

  function getPointerPos(ev) {
    const rect = renderer.domElement.getBoundingClientRect();
    pointer.x = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((ev.clientY - rect.top) / rect.height) * 2 + 1;
  }

  /**
   * Find a node under the pointer by raycasting against all objects in the scene.
   */
  function findNodeUnderPointer(ev) {
    getPointerPos(ev);
    raycaster.setFromCamera(pointer, camera);

    // Raycast against the force graph scene (includes instanced meshes + individual meshes)
    const intersects = raycaster.intersectObjects([state.forceGraph], true);

    for (const hit of intersects) {
      const obj = hit.object;

      // Check InstancedMesh node renderer
      if (obj.__isInstancedRenderer && obj.__graphObjType === 'node' && hit.instanceId !== undefined) {
        const nodeData = obj.__instancedRenderer.getDataByInstanceId(hit.instanceId);
        if (nodeData) return { node: nodeData, point: hit.point };
      }

      // Check individual custom nodes (cluster shapes etc.)
      const graphObj = getGraphObj(obj, hit);
      if (graphObj && graphObj.__graphObjType === 'node') {
        return { node: graphObj.__data, point: hit.point };
      }
    }
    return null;
  }

  function onPointerDown(ev) {
    if (ev.button !== 0) return; // left click only
    if (!state.enableNodeDrag) return;

    const hit = findNodeUnderPointer(ev);
    if (!hit) return;

    // Don't start dragging yet — just record the candidate.
    // Drag starts only after pointer moves beyond DRAG_THRESHOLD.
    // This lets simple clicks pass through to three-render-objects cleanly.
    pendingDragNode = hit.node;
    pendingDragHit = hit;
    pointerDownPos = { x: ev.clientX, y: ev.clientY };
  }

  function startDrag() {
    dragging = true;
    dragNode = pendingDragNode;

    // Disable orbit controls now that real drag is starting
    controls.enabled = false;

    // Set up drag plane perpendicular to camera direction at node depth
    const cameraDir = new three.Vector3();
    camera.getWorldDirection(cameraDir);
    dragPlane.setFromNormalAndCoplanarPoint(cameraDir, pendingDragHit.point);

    // Offset from click point to node center
    const nodePos = new three.Vector3(dragNode.x || 0, dragNode.y || 0, dragNode.z || 0);
    dragOffset.subVectors(nodePos, pendingDragHit.point);

    // Store initial positions and pin node
    dragNode.__initialFixedPos = { fx: dragNode.fx, fy: dragNode.fy, fz: dragNode.fz };
    dragNode.__initialPos = { x: dragNode.x, y: dragNode.y, z: dragNode.z };
    ['x', 'y', 'z'].forEach(c => dragNode[`f${c}`] = dragNode[c]);
    renderer.domElement.classList.add('grabbable');

    // Clear pending state
    pendingDragNode = null;
    pendingDragHit = null;
    pointerDownPos = null;
  }

  function onPointerMove(ev) {
    // Check if pending drag should start (threshold exceeded)
    if (pendingDragNode && pointerDownPos) {
      const dx = ev.clientX - pointerDownPos.x;
      const dy = ev.clientY - pointerDownPos.y;
      if (dx * dx + dy * dy >= DRAG_THRESHOLD * DRAG_THRESHOLD) {
        startDrag();
      }
    }

    if (!dragging || !dragNode) return;

    getPointerPos(ev);
    raycaster.setFromCamera(pointer, camera);

    if (raycaster.ray.intersectPlane(dragPlane, dragIntersection)) {
      const newPos = dragIntersection.add(dragOffset);

      const translate = {
        x: newPos.x - dragNode.x,
        y: newPos.y - dragNode.y,
        z: newPos.z - dragNode.z,
      };

      ['x', 'y', 'z'].forEach(c => dragNode[`f${c}`] = dragNode[c] = newPos[c]);

      state.forceGraph
        .d3AlphaTarget(0.3)
        .resetCountdown();

      dragNode.__dragged = true;
      state.onNodeDrag(dragNode, translate);
    }
  }

  function onPointerUp(ev) {
    // Clear pending drag (user clicked without dragging — let three-render-objects handle click)
    if (pendingDragNode) {
      pendingDragNode = null;
      pendingDragHit = null;
      pointerDownPos = null;
    }

    if (!dragging) return;
    dragging = false;

    if (dragNode) {
      const initFixedPos = dragNode.__initialFixedPos;
      const initPos = dragNode.__initialPos;

      if (initFixedPos) {
        // Restore original fixed positions (unpin unless originally pinned)
        ['x', 'y', 'z'].forEach(c => {
          const fc = `f${c}`;
          if (initFixedPos[fc] === undefined) {
            delete dragNode[fc];
          }
        });

        const translate = {
          x: (initPos ? initPos.x : 0) - dragNode.x,
          y: (initPos ? initPos.y : 0) - dragNode.y,
          z: (initPos ? initPos.z : 0) - dragNode.z,
        };
        state.onNodeDragEnd(dragNode, translate);
        state._dragJustEnded = true; // Prevent click from firing

        state.forceGraph
          .d3AlphaTarget(0)
          .resetCountdown();

        delete dragNode.__initialFixedPos;
        delete dragNode.__initialPos;
        delete dragNode.__dragged;
      }

      dragNode = null;
    }

    if (state.enableNavigationControls) {
      controls.enabled = true;
    }

    renderer.domElement.classList.remove('grabbable');
  }

  renderer.domElement.addEventListener('pointerdown', onPointerDown);
  renderer.domElement.addEventListener('pointermove', onPointerMove);
  renderer.domElement.addEventListener('pointerup', onPointerUp);

  // Store cleanup function for next call
  state._dragCleanup = () => {
    renderer.domElement.removeEventListener('pointerdown', onPointerDown);
    renderer.domElement.removeEventListener('pointermove', onPointerMove);
    renderer.domElement.removeEventListener('pointerup', onPointerUp);
  };
}
