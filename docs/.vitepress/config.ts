import { defineConfig } from 'vitepress'

export default defineConfig({
  title: 'Graph Lagoon Studio',
  description: 'Open-source graph exploration platform for Databricks — zero ETL, zero extra cost, deploy with a few lines of code',
  base: process.env.VITEPRESS_BASE || '/',
  srcExclude: ['dev/**'],

  themeConfig: {
    nav: [
      { text: 'Guide', link: '/guide/getting-started' },
      {
        text: 'GitHub',
        link: 'https://github.com/graphlagoon/graphlagoon',
      },
    ],

    sidebar: [
      {
        text: 'Guide',
        items: [
          { text: 'Getting Started', link: '/guide/getting-started' },
          { text: 'Exploring the Graph', link: '/guide/exploring-the-graph' },
          { text: 'Explorations & Sharing', link: '/guide/explorations' },
        ],
      },
      {
        text: 'Visualization',
        items: [
          { text: 'Labels & Text Formatting', link: '/guide/labels' },
          { text: 'Cluster Programs', link: '/guide/clusters' },
          { text: 'Communities & Metrics', link: '/guide/communities-metrics' },
          { text: 'Style Presets', link: '/guide/style-presets' },
          { text: 'Layout URL Overrides', link: '/guide/layout-url-overrides' },
          { text: 'Query Templates', link: '/guide/query-templates' },
          { text: 'Context Menu Actions', link: '/guide/context-menu-actions' },
        ],
      },
      {
        text: 'Data Sources',
        items: [
          { text: 'REST Connections', link: '/guide/rest-connections' },
          { text: 'Precomputed Graphs', link: '/guide/precomputed-graphs' },
          { text: 'Similarity System', link: '/guide/similarity' },
        ],
      },
      {
        text: 'Deployment',
        items: [
          { text: 'Databricks Integration', link: '/guide/integration' },
          { text: 'Deploy as a Databricks App', link: '/guide/databricks-apps' },
          { text: 'Configuration', link: '/guide/configuration' },
          { text: 'Python API Reference', link: '/guide/python-api' },
        ],
      },
    ],

    socialLinks: [
      { icon: 'github', link: 'https://github.com/graphlagoon/graphlagoon' },
    ],
  },
})
