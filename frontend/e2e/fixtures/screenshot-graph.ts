/**
 * Curated graph fixture for documentation screenshots.
 *
 * Deliberately separate from MOCK_GRAPH_RESPONSE (asserted on by E2E specs):
 * this one optimizes for looking like a real dataset — ~50 labeled nodes,
 * three node types, populated side-panel properties — not for test assertions.
 *
 * Construction is index-based and fully deterministic so every run produces
 * identical data. The force layout is still non-deterministic, so
 * pixel-identical screenshots are a non-goal; readable, realistic ones are.
 */

import { MOCK_CONTEXT } from './mock-data';

const FIRST_NAMES = [
  'Ada', 'Bruno', 'Clara', 'Diego', 'Elena', 'Felipe', 'Gabriela', 'Hugo',
  'Isabela', 'João', 'Karin', 'Lucas', 'Marina', 'Nina', 'Otávio', 'Paula',
  'Rafael', 'Sofia', 'Tiago', 'Valentina', 'Wesley', 'Yara', 'Zeca', 'Bianca',
];

const LAST_NAMES = [
  'Silva', 'Oliveira', 'Santos', 'Costa', 'Pereira', 'Almeida', 'Nakamura',
  'Ferreira', 'Rocha', 'Martins', 'Barbosa', 'Ribeiro',
];

const COMPANY_NAMES = [
  'Acme Analytics', 'Globex Data', 'Initech Cloud', 'Umbrella Labs',
  'Stark Logistics', 'Wayne Software', 'Hooli Systems', 'Pied Piper',
  'Vandelay Industries', 'Wonka Digital', 'Cyberdyne AI', 'Tyrell Corp',
];

const PRODUCT_NAMES = [
  'Lagoon DB', 'GraphPad', 'QueryForge', 'NodeScope', 'EdgeWise',
  'VizFlow', 'DataReef', 'SchemaHub', 'LinkLens', 'ClusterKit',
];

const CITIES = ['São Paulo', 'Lisbon', 'Berlin', 'Austin', 'Tokyo', 'Toronto'];
const ROLES = ['Data Engineer', 'Analyst', 'PM', 'Researcher', 'Designer', 'CTO'];
const INDUSTRIES = ['Analytics', 'Logistics', 'Fintech', 'Healthcare', 'Retail'];
const CATEGORIES = ['Database', 'Visualization', 'ETL', 'Monitoring'];

const PERSON_COUNT = FIRST_NAMES.length; // 24
const COMPANY_COUNT = COMPANY_NAMES.length; // 12
const PRODUCT_COUNT = PRODUCT_NAMES.length; // 10

const people = Array.from({ length: PERSON_COUNT }, (_, i) => ({
  node_id: `person-${i}`,
  node_type: 'Person',
  properties: {
    name: `${FIRST_NAMES[i]} ${LAST_NAMES[i % LAST_NAMES.length]}`,
    role: ROLES[i % ROLES.length],
    city: CITIES[i % CITIES.length],
  },
}));

const companies = Array.from({ length: COMPANY_COUNT }, (_, i) => ({
  node_id: `company-${i}`,
  node_type: 'Company',
  properties: {
    name: COMPANY_NAMES[i],
    industry: INDUSTRIES[i % INDUSTRIES.length],
    city: CITIES[(i + 2) % CITIES.length],
  },
}));

const products = Array.from({ length: PRODUCT_COUNT }, (_, i) => ({
  node_id: `product-${i}`,
  node_type: 'Product',
  properties: {
    name: PRODUCT_NAMES[i],
    category: CATEGORIES[i % CATEGORIES.length],
    version: `${1 + (i % 3)}.${i % 10}`,
  },
}));

const nodes = [...people, ...companies, ...products];

let edgeSeq = 0;
function edge(src: string, dst: string, relationship_type: string) {
  return { edge_id: `e${edgeSeq++}`, src, dst, relationship_type, properties: {} };
}

const edges = [
  // Everyone works somewhere; two people per company on average.
  ...people.map((p, i) => edge(p.node_id, `company-${i % COMPANY_COUNT}`, 'WORKS_AT')),
  // A social ring plus a few chords so communities are visible.
  ...people.map((p, i) => edge(p.node_id, `person-${(i + 1) % PERSON_COUNT}`, 'KNOWS')),
  ...people
    .filter((_, i) => i % 3 === 0)
    .map((p, i) => edge(p.node_id, `person-${(i * 5 + 7) % PERSON_COUNT}`, 'KNOWS')),
  // Companies build products; some products are co-developed.
  ...products.map((pr, i) => edge(`company-${i % COMPANY_COUNT}`, pr.node_id, 'BUILDS')),
  ...products
    .filter((_, i) => i % 2 === 0)
    .map((pr, i) => edge(`company-${(i + 5) % COMPANY_COUNT}`, pr.node_id, 'BUILDS')),
  // A few purchases to connect people to products.
  ...people
    .filter((_, i) => i % 4 === 0)
    .map((p, i) => edge(p.node_id, `product-${(i * 3 + 1) % PRODUCT_COUNT}`, 'BOUGHT')),
];

export const SCREENSHOT_GRAPH_RESPONSE = {
  nodes,
  edges,
  truncated: false,
  metadata: {
    total_ms: 42,
    edge_query_ms: 18,
    node_query_ms: 24,
    node_count: nodes.length,
    edge_count: edges.length,
  },
};

/** Context whose graph loads the curated fixture (see seedGraphResponse). */
export const SCREENSHOT_CONTEXT = {
  ...MOCK_CONTEXT,
  id: 'ctx-screenshot',
  title: 'Social Network',
  description: 'People, companies and the products that connect them',
  tags: ['env:demo', 'team:analytics'],
  node_types: ['Person', 'Company', 'Product'],
  relationship_types: ['WORKS_AT', 'KNOWS', 'BUILDS', 'BOUGHT'],
  node_properties: [
    { name: 'name', data_type: 'string' },
    { name: 'role', data_type: 'string' },
    { name: 'city', data_type: 'string' },
    { name: 'industry', data_type: 'string' },
    { name: 'category', data_type: 'string' },
  ],
  // Custom metrics for the communities-metrics guide: one auto-run derived
  // text column, one manual structural score.
  metric_definitions: [
    {
      id: 'cm-city-tag',
      name: 'City tag',
      target: 'node',
      value_type: 'string',
      description: 'Upper-cased city, or the node type when unknown',
      code: "const c = String(item.properties.city ?? '').trim();\nreturn c ? c.toUpperCase() : item.type;",
      auto_run: true,
    },
    {
      id: 'cm-neighbour-degree',
      name: 'Neighbour mean degree',
      target: 'node',
      value_type: 'number',
      description: 'Average degree of the neighbours',
      code: 'const ns = ctx.neighbors(item.id);\nreturn ns.length ? ns.reduce((s, n) => s + ctx.degreeOf(n), 0) / ns.length : 0;',
      auto_run: false,
    },
  ],
};
