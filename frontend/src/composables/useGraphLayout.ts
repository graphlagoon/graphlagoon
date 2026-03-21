/**
 * Composable for 3D graph layout control.
 *
 * Manages the d3-force-3d simulation lifecycle: start, stop, reheat, scramble.
 */
import type { Ref } from 'vue';
import type { GraphNode } from '@/types/graph3d';

interface LayoutExecutionParams {
  cooldownTicks: number;
  ticksPerFrame: number;
}

export function useGraphLayout(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getGraph3d: () => any,
  state: {
    isLayoutRunning: Ref<boolean>;
    layoutStabilized: Ref<boolean>;
    initialLayoutDone: Ref<boolean>;
  },
  callbacks: {
    setLabelsVisible: (visible: boolean) => void;
    updateLabels: () => void;
  },
  getLayoutExecution?: () => LayoutExecutionParams,
  getIs2D?: () => boolean,
) {
  const { isLayoutRunning, layoutStabilized, initialLayoutDone } = state;

  function startLayout() {
    const graph3d = getGraph3d();
    if (!graph3d) return;
    isLayoutRunning.value = true;
    layoutStabilized.value = false;

    const exec = getLayoutExecution?.();

    callbacks.setLabelsVisible(false);
    graph3d.cooldownTicks(exec?.cooldownTicks ?? 100);
    graph3d.ticksPerFrame(exec?.ticksPerFrame ?? 1);

    const data = graph3d.graphData();
    const is2D = getIs2D?.() ?? false;
    data.nodes.forEach((node: GraphNode) => {
      node.fx = null;
      node.fy = null;
      if (is2D) {
        node.z = 0;
        node.fz = 0;
      } else {
        node.fz = null;
      }
    });

    graph3d.d3ReheatSimulation();
  }

  function stopLayout() {
    const graph3d = getGraph3d();
    if (!graph3d) return;
    isLayoutRunning.value = false;
    initialLayoutDone.value = true;

    const data = graph3d.graphData();
    const is2D = getIs2D?.() ?? false;
    data.nodes.forEach((node: GraphNode) => {
      if (node.x !== undefined) node.fx = node.x;
      if (node.y !== undefined) node.fy = node.y;
      if (is2D) {
        node.z = 0;
        node.fz = 0;
      } else if (node.z !== undefined) {
        node.fz = node.z;
      }
    });

    graph3d.cooldownTicks(0);

    callbacks.updateLabels();
    callbacks.setLabelsVisible(true);
  }

  function reheatLayout() {
    const graph3d = getGraph3d();
    if (!graph3d) return;
    isLayoutRunning.value = true;
    layoutStabilized.value = false;

    const exec = getLayoutExecution?.();

    callbacks.setLabelsVisible(false);
    graph3d.cooldownTicks(exec?.cooldownTicks ?? 100);
    graph3d.ticksPerFrame(exec?.ticksPerFrame ?? 1);

    const data = graph3d.graphData();
    const perturbationStrength = 100;

    const is2D = getIs2D?.() ?? false;
    data.nodes.forEach((node: GraphNode) => {
      node.fx = null;
      node.fy = null;

      if (node.x !== undefined) node.x += (Math.random() - 0.5) * perturbationStrength;
      if (node.y !== undefined) node.y += (Math.random() - 0.5) * perturbationStrength;

      node.vx = (Math.random() - 0.5) * 2;
      node.vy = (Math.random() - 0.5) * 2;

      if (is2D) {
        node.z = 0;
        node.fz = 0;
        node.vz = 0;
      } else {
        node.fz = null;
        if (node.z !== undefined) node.z += (Math.random() - 0.5) * perturbationStrength;
        node.vz = (Math.random() - 0.5) * 2;
      }
    });

    graph3d.graphData(data);
    graph3d.d3ReheatSimulation();
  }

  function scrambleLayout() {
    const graph3d = getGraph3d();
    if (!graph3d) return;

    const data = graph3d.graphData();
    const perturbationStrength = 150;

    let centerX = 0, centerY = 0, centerZ = 0;
    let count = 0;
    data.nodes.forEach((node: GraphNode) => {
      if (node.x !== undefined && node.y !== undefined && node.z !== undefined) {
        centerX += node.x;
        centerY += node.y;
        centerZ += node.z;
        count++;
      }
    });
    if (count > 0) {
      centerX /= count;
      centerY /= count;
      centerZ /= count;
    }

    const is2D = getIs2D?.() ?? false;
    data.nodes.forEach((node: GraphNode) => {
      node.x = centerX + (Math.random() - 0.5) * perturbationStrength * 2;
      node.y = centerY + (Math.random() - 0.5) * perturbationStrength * 2;
      node.vx = 0;
      node.vy = 0;
      node.fx = null;
      node.fy = null;
      if (is2D) {
        node.z = 0;
        node.fz = 0;
        node.vz = 0;
      } else {
        node.z = centerZ + (Math.random() - 0.5) * perturbationStrength * 2;
        node.vz = 0;
        node.fz = null;
      }
    });

    graph3d.graphData(data);
    startLayout();
  }

  return {
    isLayoutRunning,
    layoutStabilized,
    initialLayoutDone,
    startLayout,
    stopLayout,
    reheatLayout,
    scrambleLayout,
  };
}
