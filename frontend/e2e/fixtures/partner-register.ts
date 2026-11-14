/**
 * A company's partner register: one hub with `partners` direct neighbours and
 * a few of them also holding other companies (the investigative signal). Used
 * by the hub-leaves spec and its documentation screenshot.
 */
const ROLES = ['Socio', 'Acionista', 'Diretor', 'Conselheiro', 'Procurador'];

export function partnerRegister(partners: number, alsoElsewhere: number[] = [0, 1, 2]) {
  const nodes: any[] = [
    { node_id: 'hub', node_type: 'Company', properties: { name: 'Aurora S.A.' } },
    { node_id: 'other', node_type: 'Company', properties: { name: 'Holding Norte' } },
    { node_id: 'other-2', node_type: 'Company', properties: { name: 'Holding Sul' } },
  ];
  const edges: any[] = [];
  for (let i = 0; i < partners; i++) {
    nodes.push({ node_id: `p-${i}`, node_type: i % 9 === 0 ? 'Company' : 'Person', properties: { name: `Partner ${i}` } });
    // Mostly the first two roles, like a real register.
    const role = ROLES[i % 7 < 3 ? 0 : i % 7 < 5 ? 1 : 2 + (i % 3)];
    edges.push({ edge_id: `e${i}`, src: `p-${i}`, dst: 'hub', relationship_type: 'SOCIO_DE', properties: { role } });
  }
  for (const i of alsoElsewhere) {
    edges.push({ edge_id: `x${i}`, src: `p-${i}`, dst: i % 2 ? 'other' : 'other-2', relationship_type: 'SOCIO_DE', properties: { role: 'Socio' } });
  }
  return { nodes, edges, truncated: false, total_count: edges.length };
}
