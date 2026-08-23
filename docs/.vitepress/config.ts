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
          { text: 'Databricks Integration', link: '/guide/integration' },
          { text: 'Deploy as a Databricks App', link: '/guide/databricks-apps' },
          { text: 'Similarity System', link: '/guide/similarity' },
          { text: 'REST Connections', link: '/guide/rest-connections' },
          { text: 'Precomputed Graphs', link: '/guide/precomputed-graphs' },
          { text: 'Configuration', link: '/guide/configuration' },
        ],
      },
    ],

    socialLinks: [
      { icon: 'github', link: 'https://github.com/graphlagoon/graphlagoon' },
    ],
  },
})
